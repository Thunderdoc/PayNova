import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentStatus } from '@youpi/common';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

// In production, reliably ensure environment variables from .env are loaded if not already provided
if (!process.env.BASE_CHECKOUT_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(rootDir, '.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}
import {
  getDatabase,
  ensureDatabaseInitialized,
  runMigrations,
  MerchantRepository,
  ReceivingAccountRepository,
  CustomerRepository,
  CustomerSessionRepository,
  PaymentSessionRepository,
  ObservationRepository,
  SupportTicketRepository,
  AuditLogRepository,
  DeviceRepository
} from '@youpi/db';
import {
  QueueEngine,
  TimingEngine,
  AttributionEngine,
  RecoveryEngine,
  WebhookEngine,
  PaymentVerificationPipeline
} from '@youpi/core';
import { HttpServer } from './server.js';
import { EmailReceiptService } from './services/email-receipt.service.js';
import { pdfReceiptService } from './services/pdf-receipt.service.js';
import { registerPaymentRoutes } from './routes/payments.routes.js';
import { registerCheckoutRoutes } from './routes/checkout.routes.js';
import { registerPollerRoutes } from './routes/pollers.routes.js';
import { registerAdminRoutes } from './routes/admin.routes.js';
import { registerCustomerRoutes } from './routes/customer.routes.js';
import { registerDeviceRoutes } from './routes/device.routes.js';
import { getWhatsAppBerryService, WhatsAppBerryService } from './services/whatsapp-berry.service.js';
import { restoreWhatsAppSession, attachSessionPersistence } from './services/whatsapp-session-store.js';

export function createPaymentApp(customDb = null, options = {}) {
  const db = customDb || getDatabase();
  ensureDatabaseInitialized(db);
  const { defaultMerchant } = runMigrations(db);
  const isCustom = !!customDb;
  const whatsappBerryService = options.whatsappBerryService || (isCustom ? new WhatsAppBerryService({
    sessionId: 'test_berry_session',
    sessionPath: path.resolve(rootDir, 'data/test_berry_auth'),
    databasePath: path.resolve(rootDir, 'data/test_berry_store.db'),
    metaFile: path.resolve(rootDir, 'data/test_whatsapp_session.json')
  }) : getWhatsAppBerryService());

  // WhatsApp session persistence (no-op without WP_SESSION_KV_* env vars):
  // after a deploy wipes the container, the KV snapshot is restored in
  // startServer() before this point; here we wire live saves (connection.open
  // + auth-file watcher + SIGTERM flush) for the production service only.
  // Test apps (customDb / injected service) never get persistence attached.
  if (!isCustom && !options.whatsappBerryService) {
    attachSessionPersistence(whatsappBerryService, {
      rootDir,
      sessionPath: whatsappBerryService.sessionPath,
      databasePath: whatsappBerryService.databasePath,
      metaFile: whatsappBerryService.metaFile
    });
  }

  const merchantRepo = new MerchantRepository(db);
  const accountRepo = new ReceivingAccountRepository(db);
  const customerRepo = new CustomerRepository(db);
  const customerSessionRepo = new CustomerSessionRepository(db, customerRepo);
  const sessionRepo = new PaymentSessionRepository(db);
  const obsRepo = new ObservationRepository(db);
  const ticketRepo = new SupportTicketRepository(db);
  const auditRepo = new AuditLogRepository(db);
  const deviceRepo = new DeviceRepository(db);

  const eventEmitter = new EventEmitter();

  const queueEngine = new QueueEngine({
    sessionRepo,
    accountRepo,
    eventEmitter,
    auditRepo
  });

  const timingEngine = new TimingEngine({
    sessionRepo,
    queueEngine,
    eventEmitter,
    auditRepo,
    activeDurationMs: Number(process.env.PAYMENT_ACTIVE_WINDOW_MS || 300000),
    processingDurationMs: Number(process.env.PAYMENT_PROCESSING_WINDOW_MS || 30000)
  });

  const attributionEngine = new AttributionEngine({
    sessionRepo,
    obsRepo,
    ticketRepo,
    auditRepo,
    eventEmitter
  });

  const recoveryEngine = new RecoveryEngine({
    db,
    sessionRepo,
    accountRepo,
    queueEngine,
    timingEngine,
    auditRepo
  });

  const webhookEngine = new WebhookEngine({
    db,
    merchantRepo,
    maxRetries: Number(process.env.WEBHOOK_MAX_RETRIES || 5)
  });

  const server = new HttpServer();
  let checkoutBaseUrl = process.env.BASE_CHECKOUT_URL || 'http://localhost:7000';
  try {
    const rootEnv = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(rootEnv)) {
      const raw = fs.readFileSync(rootEnv, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('BASE_CHECKOUT_URL=')) {
          const val = trimmed.split('=')[1]?.trim();
          if (val) checkoutBaseUrl = val.replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch {}

  // BULLETPROOF QUEUE PROMOTION HANDLER
  function handleSlotFreedAndPromote(receivingAccountId) {
    if (!receivingAccountId) return null;
    const promoted = queueEngine.promoteNext(receivingAccountId);
    if (promoted) {
      if (promoted.expiresAt) {
        timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
      }
      server.broadcastSse(promoted.id, 'status_change', {
        status: PaymentStatus.ACTIVE,
        queuePosition: 0,
        expiresAt: promoted.expiresAt
      });
      server.broadcastSse(`queue_${receivingAccountId}`, 'queue_update', {
        promotedId: promoted.id
      });
    }
    return promoted;
  }

  const emailReceiptService = new EmailReceiptService({ merchantRepo });

  // When a payment succeeds, fails, expires, or cancels: dispatch webhook & promote next queued customer
  eventEmitter.on('PAYMENT.SUCCESS', async (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', {
        status: PaymentStatus.SUCCESS,
        verificationLevel: data.verificationLevel || session.verificationLevel || 1,
        verificationTag: data.verificationTag || session.verificationTag,
        sources: data.sources || session.verificationSources
      });
      server.broadcastSse('admin_counter_events', 'payment_received', {
        sessionId: session.id,
        orderId: session.orderId,
        amount: (Number(session.amountPaise) / 100).toFixed(2),
        amountPaise: session.amountPaise.toString(),
        currency: session.currency || 'INR',
        customerName: session.metadata?.customerName || null
      });
      webhookEngine.dispatch('SUCCESS', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);

      // Automated Customer Confirmation & PDF Receipt Generation
      try {
        const customer = session.customerId ? customerRepo.findById(session.customerId) : null;
        const targetEmail = customer?.email || session.metadata?.customerEmail;
        const targetPhone = customer?.mobileNumber || session.metadata?.customerPhone || session.metadata?.phone;
        const displayAmount = session.amountPaise ? (Number(session.amountPaise) / 100).toFixed(2) : '1.00';
        const merchant = merchantRepo.findById(session.merchantId);
        const branding = merchant?.branding || {};
        const brandName = merchant?.businessName || branding.businessName || 'PayNova';
        const utrVal = session.utr || session.bankReference || data.bankReference || 'Direct UPI Settlement';
        const custName = customer?.name || session.metadata?.customerName || 'Valued Customer';
        let methodStr = session.method || 'UPI';
        if (methodStr === 'UPI') {
          methodStr = 'UPI';
        } else if (!methodStr.startsWith('UPI')) {
          methodStr = `UPI (${methodStr})`;
        }
        const supportPhone = (branding.supportMobiles && branding.supportMobiles[0]) || '+91 7092620770';
        const supportEmail = (branding.supportEmails && branding.supportEmails[0]) || 'ankitraj2163@gmail.com';
        const supportContact = supportPhone || supportEmail;
        const websiteUrl = branding.websiteUrl || 'https://paynova.in';

        // Collision-resistant unique receipt number & secure download link
        const receiptNumber = session.metadata?.receiptNumber || `RCP-${Date.now().toString(36).toUpperCase()}-${session.orderId.replace(/[^A-Z0-9]/gi, '').slice(-6)}`;
        const secureReceiptUrl = `${checkoutBaseUrl || 'http://localhost:7000'}/api/v1/receipts/${session.id}/download`;

        // Generate vector PDF receipt buffer
        let pdfBuffer = null;
        try {
          pdfBuffer = await pdfReceiptService.generateReceiptBuffer({
            receiptNumber,
            orderId: session.orderId,
            amount: displayAmount,
            currency: session.currency || 'INR',
            customerName: custName,
            customerEmail: targetEmail,
            customerPhone: targetPhone,
            paymentMethod: methodStr,
            utr: utrVal,
            paidAt: session.completedAt || new Date().toISOString(),
            businessName: brandName,
            supportEmail,
            supportPhone,
            websiteUrl
          });
        } catch (pdfErr) {
          console.warn('[payment-api] Error generating PDF receipt buffer:', pdfErr.message);
        }

        // Persist receipt metadata against session
        try {
          sessionRepo.update(session.id, {
            metadata: {
              ...(session.metadata || {}),
              receiptNumber,
              secureReceiptUrl,
              receiptGeneratedAt: Date.now()
            }
          });
        } catch {}

        const waCfg = branding.waReceiptConfig || {};
        const isEmailEnabled = waCfg.emailReceiptEnabled !== false;

        // 1. Send Email Receipt with attached PDF & download link
        if (isEmailEnabled && targetEmail) {
          emailReceiptService.sendPaymentReceipt({
            toEmail: targetEmail,
            customerName: custName,
            orderId: session.orderId,
            receiptNumber,
            receiptUrl: secureReceiptUrl,
            amount: displayAmount,
            utr: utrVal,
            paymentMethod: methodStr,
            businessName: brandName,
            pdfBuffer,
            pdfFileName: `Receipt-${session.orderId}.pdf`
          }).catch(err => {
            console.warn('[payment-api] Background email receipt dispatch error:', err.message);
          });
        }

        // 2. Send Instant WhatsApp Payment Receipt via connected Berry Protocol socket
        const isWaEnabled = waCfg.enabled !== undefined ? waCfg.enabled : true;

        if (isWaEnabled && targetPhone && whatsappBerryService && whatsappBerryService.isConnected) {
          if (!global._waReceiptSentSet) global._waReceiptSentSet = new Set();
          const idempotencyKey = `wa_${session.id}_${session.orderId}`;
          if (!global._waReceiptSentSet.has(idempotencyKey)) {
            global._waReceiptSentSet.add(idempotencyKey);

            const cleanPhone = String(targetPhone).replace(/\D/g, '');
            const waNumber = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;

            // Template interpolation helper
            const applyPlaceholders = (tmpl) => {
              if (!tmpl) return '';
              return tmpl
                .replace(/{{customer_name}}/gi, custName)
                .replace(/{{company_name}}/gi, brandName)
                .replace(/{{order_id}}/gi, session.orderId)
                .replace(/{{amount}}/gi, displayAmount)
                .replace(/{{currency}}/gi, '₹')
                .replace(/{{payment_method}}/gi, methodStr)
                .replace(/{{utr}}/gi, utrVal)
                .replace(/{{transaction_reference}}/gi, utrVal)
                .replace(/{{receipt_number}}/gi, receiptNumber)
                .replace(/{{secure_receipt_url}}/gi, secureReceiptUrl)
                .replace(/{{support_contact}}/gi, supportContact);
            };

            const rawGreeting = waCfg.greeting || 'Hi {{customer_name}}! 👋';
            const rawIntro = waCfg.intro || 'Your payment has been verified successfully. Thank you for choosing {{company_name}}!';
            const resolvedGreeting = applyPlaceholders(rawGreeting);
            const resolvedIntro = applyPlaceholders(rawIntro).replace(new RegExp(brandName, 'g'), `*${brandName}*`);

            let fields = [];
            if (waCfg.showReceiptNo !== false) fields.push(`🧾 *Receipt No:* ${receiptNumber}`);
            if (waCfg.showOrderId !== false) fields.push(`📄 *Order ID:* #${session.orderId}`);
            if (waCfg.showAmount !== false) fields.push(`💰 *Amount Paid:* ₹${displayAmount}`);
            if (waCfg.showMethod !== false) fields.push(`💳 *Payment Method:* ${methodStr}`);
            if (waCfg.showUtr !== false) fields.push(`🔖 *Reference / UTR:* ${utrVal}`);

            let waMessage = `✅ *Payment Successful!*\n\n${resolvedGreeting}\n\n${resolvedIntro}\n`;
            if (fields.length > 0) {
              waMessage += `\n━━━━━━━━━━━━━━━━━━\n${fields.join('\n')}\n━━━━━━━━━━━━━━━━━━\n`;
            }
            waMessage += `\n📄 *Your official PDF payment receipt is attached to this message.*\n`;
            // The official receipt is sent as a PDF document attachment.
            if (waCfg.supportText) {
              waMessage += `\n${applyPlaceholders(waCfg.supportText)}\n`;
            }
            if (waCfg.footerNote) {
              waMessage += `\n${applyPlaceholders(waCfg.footerNote)}\n*${brandName}*`;
            }

            // Dispatch PDF as actual WhatsApp document attachment
            const pdfDocFileName = `PayNova_Receipt_${receiptNumber}.pdf`;
            if (!pdfBuffer) {
              console.warn('[payment-api] WhatsApp receipt skipped: PDF generation returned no buffer.');
              return;
            }
            whatsappBerryService.sendDocument(waNumber, pdfBuffer, pdfDocFileName, waMessage.trim()).then(res => {
              if (res?.success) {
                console.log(`[payment-api] Official PayNova PDF receipt document delivered to ${waNumber} (ID: ${res.id})`);
              }
            }).catch(err => {
              console.warn('[payment-api] WhatsApp document receipt dispatch error:', err.message);
              // Do not substitute a link/text receipt for the requested PDF.
            });
          }
        }
      } catch (err) {
        console.warn('[payment-api] Error preparing confirmation messages & PDF receipt:', err.message);
      }
    }
  });

  eventEmitter.on('PAYMENT.LEVEL1_VERIFIED', (data) => {
    server.broadcastSse(data.paymentId, 'status_change', {
      status: 'VERIFYING',
      verificationLevel: 1,
      verificationTag: data.verificationTag,
      message: 'Payment detected! Verifying secondary channel...'
    });
  });

  eventEmitter.on('PAYMENT.FAILED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      webhookEngine.dispatch('FAILED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.EXPIRED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', {
        status: PaymentStatus.EXPIRED
      });
      webhookEngine.dispatch('EXPIRED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.CANCELLED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', {
        status: PaymentStatus.CANCELLED
      });
      webhookEngine.dispatch('CANCELLED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.FRAUD_BLOCKED', (data) => {
    if (data.sessionId) {
      server.broadcastSse(data.sessionId, 'status_change', {
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        orderId: data.orderId,
        reason: data.reason || 'FRAUDULENT_PAYMENT_INJECTION',
        blockedNotice: {
          title: 'FRAUDULENT ACTIVITY DETECTED',
          subtitle: 'Payment Session Terminated & Account Suspended',
          message: 'Our automated verification engine detected fraudulent payment activity associated with this account. Access has been immediately suspended while our security operations team investigates the issue.',
          investigating: true
        }
      });
      server.broadcastSse(data.sessionId, 'account_blocked', {
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        orderId: data.orderId,
        reason: data.reason || 'FRAUDULENT_PAYMENT_INJECTION'
      });
    }
  });

  // Active 30-Second Verification Polling Orchestrator (Triple Verification Standard):
  // Concurrently sweeps Gmail, Google Messages SMS, and Android Observer every 1.5s
  // Continues polling for remaining sources until Level 3 (Triple Verification) is reached or 30s window finishes!
  const activeSweepTimers = new Set();

  eventEmitter.on('SESSION.PROCESSING', (data) => {
    const sessionId = data.sessionId;
    let sweepCount = 0;
    const maxSweeps = 20; // 20 sweeps * 1.5s = 30 seconds

    const sweepTimer = setInterval(async () => {
      try {
        sweepCount++;
        const current = sessionRepo.findById(sessionId);

        // Stop polling if session is terminal failed/expired/cancelled, or reached full Triple Verification (level >= 3), or exceeded 30s
        const isCompleteOrCancelled = !current ||
          current.status === PaymentStatus.FAILED ||
          current.status === PaymentStatus.EXPIRED ||
          current.status === PaymentStatus.CANCELLED ||
          (current.verificationLevel >= 3) ||
          sweepCount >= maxSweeps;

        if (isCompleteOrCancelled) {
          clearInterval(sweepTimer);
          activeSweepTimers.delete(sweepTimer);
          return;
        }

        // Sweep 1: Google Messages Web SMS
        try {
          const smsPort = Number(process.env.SMS_OBSERVER_PORT || 6002);
          fetch(`http://localhost:${smsPort}/api/sweep`, { method: 'POST', signal: AbortSignal.timeout(1200) }).catch(() => {});
        } catch {}

        // Sweep 2: Gmail Inbox
        try {
          const gmailPort = Number(process.env.GMAIL_OBSERVER_PORT || 6003);
          fetch(`http://localhost:${gmailPort}/api/sweep`, { method: 'POST', signal: AbortSignal.timeout(1200) }).catch(() => {});
        } catch {}

        // Sweep 3: Check pending/unattributed Android push notifications in DB
        try {
          const unattributed = obsRepo.findUnattributed(current.receivingAccountId);
          for (const obs of unattributed) {
            attributionEngine.processObservation({
              source: obs.source,
              receivingAccountId: obs.receivingAccountId,
              amountPaise: obs.amountPaise,
              observedAt: obs.observedAt,
              bankReferenceNumber: obs.bankReferenceNumber,
              senderVpa: obs.senderVpa,
              rawPayload: obs.rawPayload,
              fingerprintHash: obs.fingerprintHash
            });
          }
        } catch {}
      } catch {
        clearInterval(sweepTimer);
        activeSweepTimers.delete(sweepTimer);
      }
    }, 1500);

    if (sweepTimer.unref) sweepTimer.unref();
    activeSweepTimers.add(sweepTimer);
  });

  // Continuous 1-second background queue sync and auto-expiry daemon
  const queueSyncDaemon = setInterval(() => {
    try {
      const nowIso = new Date().toISOString();

      // Sweep expired ACTIVE sessions
      const expiredActive = db.query(`
        SELECT id, receiving_account_id FROM payment_sessions
        WHERE status = 'ACTIVE' AND expires_at <= ?
      `, [nowIso]);

      for (const row of expiredActive) {
        sessionRepo.transitionToTerminal(row.id, PaymentStatus.EXPIRED);
        server.broadcastSse(row.id, 'status_change', { status: PaymentStatus.EXPIRED });
        handleSlotFreedAndPromote(row.receiving_account_id);
      }

      // Sweep failed PROCESSING sessions
      const failedProc = db.query(`
        SELECT id, receiving_account_id FROM payment_sessions
        WHERE status = 'PROCESSING' AND processing_expires_at <= ?
      `, [nowIso]);

      for (const row of failedProc) {
        sessionRepo.transitionToTerminal(row.id, PaymentStatus.FAILED);
        server.broadcastSse(row.id, 'status_change', { status: PaymentStatus.FAILED });
        handleSlotFreedAndPromote(row.receiving_account_id);
      }

      // Scan for vacant receiving accounts that have waiting queued sessions
      const vacantAccounts = db.query(`
        SELECT id FROM payment_receiving_accounts
        WHERE is_active = 1 AND (is_slot_busy = 0 OR current_active_session_id IS NULL)
      `);

      for (const acc of vacantAccounts) {
        handleSlotFreedAndPromote(acc.id);
      }
    } catch {}
  }, 1000);

  if (queueSyncDaemon.unref) queueSyncDaemon.unref();

  // Continuous 1-Second Aggressive Polling Daemon across SMS Gateway & Gmail Observers
  const aggressivePollerDaemon = setInterval(async () => {
    try {
      // Find all active/processing sessions currently waiting for bank confirmation
      const activeSessions = db.query(`
        SELECT id, receiving_account_id, amount_paise, status
        FROM payment_sessions
        WHERE status IN ('ACTIVE', 'PROCESSING') AND method = 'UPI'
      `);

      if (activeSessions.length === 0) return;

      // 1. Poll SMS Observer
      try {
        const smsPort = Number(process.env.SMS_OBSERVER_PORT || 6002);
        fetch(`http://localhost:${smsPort}/api/sweep`, { method: 'POST', signal: AbortSignal.timeout(800) }).catch(() => {});
      } catch {}

      // 2. Poll Gmail Observer
      try {
        const gmailPort = Number(process.env.GMAIL_OBSERVER_PORT || 6003);
        fetch(`http://localhost:${gmailPort}/api/sweep`, { method: 'POST', signal: AbortSignal.timeout(800) }).catch(() => {});
      } catch {}

      // 3. Sweep any pending unattributed observations in DB matching active sessions
      for (const session of activeSessions) {
        try {
          const unattributed = obsRepo.findUnattributed(session.receiving_account_id);
          for (const obs of unattributed) {
            attributionEngine.processObservation({
              source: obs.source,
              receivingAccountId: obs.receivingAccountId,
              amountPaise: obs.amountPaise,
              observedAt: obs.observedAt,
              bankReferenceNumber: obs.bankReferenceNumber,
              senderVpa: obs.senderVpa,
              rawPayload: obs.rawPayload,
              fingerprintHash: obs.fingerprintHash
            });
          }
        } catch {}
      }
    } catch {}
  }, 1000);

  if (aggressivePollerDaemon.unref) aggressivePollerDaemon.unref();

  // Execute crash recovery on boot
  const recoveryStats = recoveryEngine.recover();

  // Health check routes
  const healthHandler = (req, res) => {
    HttpServer.json(res, 200, {
      status: 'UP',
      service: 'payment-api',
      timestamp: new Date().toISOString(),
      recoveryStats
    });
  };
  server.get('/health', healthHandler);
  server.get('/api/v1/health', healthHandler);

  const pipeline = new PaymentVerificationPipeline({
    db,
    sessionRepo,
    obsRepo,
    customerRepo,
    attributionEngine,
    auditRepo,
    merchantRepo,
    server,
    eventEmitter
  });

  const context = {
    db,
    merchantRepo,
    accountRepo,
    customerRepo,
    customerSessionRepo,
    sessionRepo,
    deviceRepo,
    obsRepo,
    ticketRepo,
    auditRepo,
    queueEngine,
    timingEngine,
    attributionEngine,
    pipeline,
    recoveryEngine,
    eventEmitter,
    defaultMerchant,
    checkoutBaseUrl,
    whatsappBerryService,
    webhookEngine
  };

  registerPaymentRoutes(server, context);
  registerCheckoutRoutes(server, context);
  registerPollerRoutes(server, context);
  registerAdminRoutes(server, context);
  registerCustomerRoutes(server, context);
  registerDeviceRoutes(server, context);

  function destroy() {
    clearInterval(queueSyncDaemon);
    clearInterval(aggressivePollerDaemon);
    for (const timer of activeSweepTimers) {
      clearInterval(timer);
    }
    activeSweepTimers.clear();
    timingEngine.destroy();
    if (typeof attributionEngine.destroy === 'function') {
      attributionEngine.destroy();
    }
  }

  return {
    server,
    context,
    destroy,
    rawServer: server.createServer()
  };
}

export async function startServer(port = null, customDb = null) {
  const finalPort = port || Number(process.env.PAYMENT_API_PORT || 6100);

  // ORDERING GUARANTEE: restore the KV session snapshot BEFORE
  // createPaymentApp() constructs the Berry singleton, because the singleton
  // constructor synchronously reads the session files (restoreSessionMeta)
  // and only auto-resumes if they are already on disk. restoreWhatsAppSession
  // never throws and is a no-op without WP_SESSION_KV_* env vars.
  await restoreWhatsAppSession();

  const app = createPaymentApp(customDb);

  return new Promise(resolve => {
    const instance = app.rawServer.listen(finalPort, () => {
      console.log(`[Payment API] Server listening on port ${finalPort}`);
      resolve({
        app,
        port: finalPort,
        close: () => new Promise(cb => {
          app.destroy();
          instance.close(cb);
        })
      });
    });
  });
}

// Auto-run if executed directly as main script
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
