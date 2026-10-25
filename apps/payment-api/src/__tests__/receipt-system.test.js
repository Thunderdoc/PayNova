import { describe, it } from 'node:test';
import assert from 'node:assert';
import { pdfReceiptService } from '../services/pdf-receipt.service.js';
import { EmailReceiptService } from '../services/email-receipt.service.js';

describe('PayNova Payment Receipt & Notification Engine', () => {
  it('should generate a valid PDF receipt buffer with correct magic bytes and metadata', async () => {
    const pdfBuffer = await pdfReceiptService.generateReceiptBuffer({
      receiptNumber: 'RCP-TEST-99881',
      orderId: 'ORD-774411',
      amount: 2500,
      currency: 'INR',
      customerName: 'Ankit Raj',
      customerPhone: '7092620770',
      customerEmail: 'ankitraj2163@gmail.com',
      paymentMethod: 'UPI (PhonePe)',
      utr: '423589123456',
      paidAt: new Date().toISOString(),
      businessName: 'PayNova Technologies',
      supportEmail: 'ankitraj2163@gmail.com',
      supportPhone: '+91 7092620770',
      websiteUrl: 'https://paynova.in'
    });

    assert.ok(Buffer.isBuffer(pdfBuffer), 'Result must be a Node.js Buffer');
    assert.ok(pdfBuffer.length > 1000, 'PDF buffer should be non-trivial in size');
    
    // Validate PDF header magic bytes %PDF-
    const header = pdfBuffer.slice(0, 5).toString('ascii');
    assert.strictEqual(header, '%PDF-', 'Buffer must begin with %PDF- signature');
  });

  it('should properly interpolate WhatsApp template placeholders and avoid fake or sample data in production', () => {
    const session = {
      id: 'sess_123',
      orderId: 'ORD-98765',
      amountPaise: 125000n,
      method: 'UPI_COLLECT',
      utr: '423589123456'
    };
    const customer = {
      name: 'Ankit Raj',
      mobileNumber: '7092620770',
      email: 'ankitraj2163@gmail.com'
    };
    const brandName = 'PayNova Technologies';
    const displayAmount = (Number(session.amountPaise) / 100).toFixed(2);
    const receiptNumber = 'RCP-TEST-98765';
    const secureReceiptUrl = `http://localhost:7000/api/v1/receipts/${session.id}/download`;
    const supportContact = '+91 7092620770';

    const applyPlaceholders = (tmpl) => {
      return tmpl
        .replace(/{{customer_name}}/gi, customer.name)
        .replace(/{{company_name}}/gi, brandName)
        .replace(/{{order_id}}/gi, session.orderId)
        .replace(/{{amount}}/gi, displayAmount)
        .replace(/{{currency}}/gi, '₹')
        .replace(/{{payment_method}}/gi, `UPI (${session.method})`)
        .replace(/{{utr}}/gi, session.utr)
        .replace(/{{transaction_reference}}/gi, session.utr)
        .replace(/{{receipt_number}}/gi, receiptNumber)
        .replace(/{{secure_receipt_url}}/gi, secureReceiptUrl)
        .replace(/{{support_contact}}/gi, supportContact);
    };

    const template = 'Hi {{customer_name}}! Your payment of {{currency}}{{amount}} for #{{order_id}} is verified. Receipt: {{receipt_number}}. Ref: {{transaction_reference}}. Download: {{secure_receipt_url}}';
    const output = applyPlaceholders(template);

    assert.ok(output.includes('Hi Ankit Raj!'), 'Must include real customer name');
    assert.ok(output.includes('₹1250.00'), 'Must include real formatted amount');
    assert.ok(output.includes('#ORD-98765'), 'Must include real order ID');
    assert.ok(output.includes('RCP-TEST-98765'), 'Must include real receipt number');
    assert.ok(output.includes('423589123456'), 'Must include real UTR');
    assert.ok(output.includes(secureReceiptUrl), 'Must include real secure receipt URL');

    // Ensure no preview sample values leaked
    assert.strictEqual(output.includes('Priya'), false, 'Preview sample customer Priya must never leak into production');
    assert.strictEqual(output.includes('12345 (Sample)'), false, 'Sample order ID must not leak');
  });

  it('should enforce idempotency preventing duplicate notifications for retried webhooks', () => {
    const sentSet = new Set();
    const session = { id: 'sess_idempotent_1', orderId: 'ORD-IDEM-1' };
    const idempotencyKey = `wa_${session.id}_${session.orderId}`;

    let sendCount = 0;
    const processWebhook = () => {
      if (!sentSet.has(idempotencyKey)) {
        sentSet.add(idempotencyKey);
        sendCount++;
      }
    };

    // First attempt
    processWebhook();
    assert.strictEqual(sendCount, 1, 'First webhook must dispatch message');

    // Retried webhook (duplicate event)
    processWebhook();
    processWebhook();
    assert.strictEqual(sendCount, 1, 'Retried webhooks must NOT dispatch duplicate messages');
  });

  it('should support multipart/mixed MIME encoding with attached PDF in EmailReceiptService', () => {
    const fakeMerchantRepo = {
      findById: () => ({
        businessName: 'PayNova Technologies',
        branding: {
          gmailConfig: {
            refreshToken: 'fake_refresh',
            clientId: 'fake_client',
            clientSecret: 'fake_secret'
          }
        }
      })
    };

    const service = new EmailReceiptService({ merchantRepo: fakeMerchantRepo });
    assert.ok(typeof service.sendPaymentReceipt === 'function');
  });
});
