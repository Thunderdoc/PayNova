/**
 * email-receipt.service.js
 * Automated customer receipt dispatcher via official Google Gmail API
 * Designed to be a pixel-perfect replica of the verified payment notification card.
 */

export class EmailReceiptService {
  constructor({ merchantRepo }) {
    this.merchantRepo = merchantRepo;
  }

  /**
   * Refreshes access token using merchant's connected Gmail refresh token
   */
  async getAccessToken(gmailConfig) {
    if (!gmailConfig?.clientId || !gmailConfig?.clientSecret || !gmailConfig?.refreshToken) {
      return null;
    }

    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: gmailConfig.clientId,
          client_secret: gmailConfig.clientSecret,
          refresh_token: gmailConfig.refreshToken,
          grant_type: 'refresh_token'
        }).toString(),
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.warn('[EmailReceiptService] Token refresh error:', err);
        return null;
      }

      const data = await res.json();
      return data.access_token;
    } catch (e) {
      console.warn('[EmailReceiptService] Failed to obtain access token:', e.message);
      return null;
    }
  }

  /**
   * Sends a styled receipt email to the customer using the connected merchant Gmail account
   */
  async sendPaymentReceipt({
    toEmail,
    customerName,
    orderId,
    receiptNumber,
    receiptUrl,
    amount,
    utr,
    paymentMethod,
    merchantId,
    businessName,
    pdfBuffer,
    pdfFileName
  }) {
    if (!toEmail || !toEmail.includes('@') || toEmail.endsWith('@customer.youpi.local')) {
      return { sent: false, reason: 'INVALID_OR_DUMMY_EMAIL' };
    }

    const merchant = this.merchantRepo?.findById(merchantId || '00000000-0000-0000-0000-000000000001');
    const branding = merchant?.branding || {};
    const gmailConfig = branding.gmailConfig;
    if (!gmailConfig?.refreshToken) {
      return { sent: false, reason: 'GMAIL_NOT_CONNECTED' };
    }

    const accessToken = await this.getAccessToken(gmailConfig);
    if (!accessToken) {
      return { sent: false, reason: 'TOKEN_REFRESH_FAILED' };
    }

    // Dynamic Whitelabel Metadata
    const brand = businessName || merchant?.businessName || 'PayNova';
    const sender = gmailConfig.connectedEmail || 'support@paynova.local';
    const displayAmount = Number(amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    
    // Normalize payment method cleanly (prevents UPI (UPI (UPI)) duplication)
    let methodStr = (paymentMethod || 'UPI').trim();
    while (/^UPI\s*\((.*)\)$/i.test(methodStr)) {
      methodStr = methodStr.replace(/^UPI\s*\((.*)\)$/i, '$1').trim();
    }
    if (!methodStr || methodStr.toUpperCase() === 'UPI') {
      methodStr = 'UPI';
    } else {
      methodStr = `UPI (${methodStr})`;
    }

    const utrStr = utr || 'Direct UPI Settlement';
    const custName = customerName || 'Valued Customer';
    
    // Contact Info Customizable per merchant
    const supportEmail = (branding.supportEmails && branding.supportEmails[0]) || merchant?.contactEmail || sender;
    const supportPhone = (branding.supportMobiles && branding.supportMobiles[0]) || merchant?.contactPhone || '+91 7092620770';
    const websiteUrl = branding.websiteUrl || branding.customDomain || 'www.paynova.in';
    const cleanWebsiteUrl = websiteUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    
    // Formatted date string (e.g. 18 Oct 2026, 10:24 AM)
    const now = new Date();
    const dateFormatted = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const timeFormatted = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
    const dateTimeStr = `${dateFormatted}, ${timeFormatted}`;

    const subject = `✅ Payment Confirmation – Order #${orderId}`;

    const htmlBody = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Payment Confirmation</title>
  <style>
    @media only screen and (max-width: 600px) {
      .email-container { width: 100% !important; border-radius: 0 !important; }
      .email-cell { padding-left: 16px !important; padding-right: 16px !important; }
      .receipt-row { display: block !important; width: 100% !important; }
      .receipt-val { text-align: left !important; padding-top: 2px !important; }
    }
  </style>
</head>
<body style="margin:0; padding:16px 0; background-color:#f1f5f9; color:#0f172a; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td align="center" style="padding:0 8px;">
        <!-- MAIN CONTAINER -->
        <table role="presentation" class="email-container" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:580px; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 8px 24px rgba(15,23,42,0.08); border:1px solid #e2e8f0;">
          
          <!-- BRAND HEADER BANNER -->
          <tr>
            <td class="email-cell" style="background:#092557; background: linear-gradient(135deg, #091a3c 0%, #0d2858 50%, #081d44 100%); padding:22px 24px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="left" valign="middle">
                    <table role="presentation" border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="width:38px; height:38px; background:rgba(255,255,255,0.12); border:1px solid rgba(255,255,255,0.22); border-radius:10px; text-align:center; vertical-align:middle; font-size:20px; font-weight:800; color:#ffffff; font-family:'Segoe UI', sans-serif;">
                          ${brand.charAt(0).toUpperCase()}
                        </td>
                        <td style="padding-left:12px;">
                          <div style="font-size:16px; font-weight:800; letter-spacing:0.04em; color:#ffffff; text-transform:uppercase; line-height:1.2;">
                            ${brand}
                          </div>
                          <div style="font-size:10px; font-weight:600; color:#93c5fd; letter-spacing:0.08em; text-transform:uppercase; margin-top:2px;">
                            Official Payment Confirmation Receipt
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td align="right" valign="middle" style="font-size:12px; color:#cbd5e1; font-weight:500;">
                    Thank you for<br><span style="color:#ffffff; font-weight:700;">choosing us!</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- HERO SUCCESS PILL -->
          <tr>
            <td class="email-cell" style="padding:20px 24px 12px;">
              <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:14px; padding:16px 20px; text-align:center;">
                <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:0 auto 6px;">
                  <tr>
                    <td style="width:28px; height:28px; background:#16a34a; border-radius:50%; text-align:center; vertical-align:middle; color:#ffffff; font-size:16px; font-weight:bold;">
                      ✓
                    </td>
                    <td style="padding-left:10px; font-size:19px; font-weight:800; color:#0f172a; letter-spacing:-0.01em;">
                      Payment Successful!
                    </td>
                  </tr>
                </table>
                <div style="font-size:13px; color:#15803d; font-weight:600;">
                  Your payment has been received and verified.
                </div>
              </div>
            </td>
          </tr>

          <!-- GREETING & BODY -->
          <tr>
            <td class="email-cell" style="padding:12px 24px 16px; color:#334155; font-size:14px; line-height:1.55;">
              <p style="margin:0 0 8px; font-size:15px; font-weight:700; color:#0f172a;">
                Hi ${custName},
              </p>
              <p style="margin:0; font-size:14px; color:#475569;">
                Your payment of <strong style="color:#0f172a;">₹${displayAmount}</strong> for <strong style="color:#0f172a;">Order #${orderId}</strong> has been successfully verified. Thank you for choosing <strong style="color:#0f172a;">${brand}</strong>!
              </p>
            </td>
          </tr>

          <!-- INVOICE RECEIPT TABLE -->
          <tr>
            <td class="email-cell" style="padding:0 24px 20px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:6px 16px;">
                ${receiptNumber ? `
                <tr>
                  <td class="receipt-row" style="padding:10px 0; border-bottom:1px solid #edf2f7; font-size:12.5px; color:#64748b; font-weight:600;">
                    🧾 Receipt No.
                  </td>
                  <td class="receipt-row receipt-val" align="right" style="padding:10px 0; border-bottom:1px solid #edf2f7; font-size:13px; color:#0f172a; font-weight:700; font-family:monospace; word-break:break-all;">
                    ${receiptNumber}
                  </td>
                </tr>` : ''}
                <tr>
                  <td class="receipt-row" style="padding:10px 0; border-bottom:1px solid #edf2f7; font-size:12.5px; color:#64748b; font-weight:600;">
                    📄 Order ID
                  </td>
                  <td class="receipt-row receipt-val" align="right" style="padding:10px 0; border-bottom:1px solid #edf2f7; font-size:13px; color:#0f172a; font-weight:700; font-family:monospace; word-break:break-all;">
                    #${orderId}
                  </td>
                </tr>
                <tr>
                  <td class="receipt-row" style="padding:10px 0; border-bottom:1px solid #edf2f7; font-size:12.5px; color:#64748b; font-weight:600;">
                    💰 Amount Paid
                  </td>
                  <td class="receipt-row receipt-val" align="right" style="padding:10px 0; border-bottom:1px solid #edf2f7; font-size:15px; color:#16a34a; font-weight:800;">
                    ₹${displayAmount}
                  </td>
                </tr>
                <tr>
                  <td class="receipt-row" style="padding:10px 0; border-bottom:1px solid #edf2f7; font-size:12.5px; color:#64748b; font-weight:600;">
                    💳 Payment Method
                  </td>
                  <td class="receipt-row receipt-val" align="right" style="padding:10px 0; border-bottom:1px solid #edf2f7; font-size:13px; color:#0f172a; font-weight:600;">
                    ${methodStr}
                  </td>
                </tr>
                <tr>
                  <td class="receipt-row" style="padding:10px 0; border-bottom:1px solid #edf2f7; font-size:12.5px; color:#64748b; font-weight:600;">
                    🧾 UTR / Reference No.
                  </td>
                  <td class="receipt-row receipt-val" align="right" style="padding:10px 0; border-bottom:1px solid #edf2f7; font-size:13px; color:#0f172a; font-weight:800; font-family:monospace; word-break:break-all;">
                    ${utrStr}
                  </td>
                </tr>
                <tr>
                  <td class="receipt-row" style="padding:10px 0; font-size:12.5px; color:#64748b; font-weight:600;">
                    📅 Payment Date &amp; Time
                  </td>
                  <td class="receipt-row receipt-val" align="right" style="padding:10px 0; font-size:12.5px; color:#334155; font-weight:600;">
                    ${dateTimeStr}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- VIEW ORDER DETAILS / DOWNLOAD RECEIPT BUTTON -->
          <tr>
            <td align="center" style="padding:0 28px 22px;">
              <table role="presentation" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center" style="background:#092557; border-radius:10px;">
                    <a href="${receiptUrl || `https://${cleanWebsiteUrl}`}" target="_blank" style="display:inline-block; padding:13px 34px; font-size:14px; font-weight:700; color:#ffffff; text-decoration:none; letter-spacing:0.02em;">
                      ${receiptUrl ? '📄 Download Receipt / View Order &rarr;' : 'View Order Details &rarr;'}
                    </a>
                  </td>
                </tr>
              </table>
              ${pdfBuffer ? `
              <div style="font-size:12px; color:#15803d; font-weight:600; margin-top:10px;">
                📎 Official PDF Receipt has also been attached to this email.
              </div>` : ''}
            </td>
          </tr>

          <!-- SUPPORT CALLOUT NOTE -->
          <tr>
            <td align="center" style="padding:0 28px 20px; font-size:13px; color:#64748b; line-height:1.5;">
              If you have any questions, feel free to contact our support team.<br>
              <span style="color:#0f172a; font-weight:600;">Thanks again for your trust! 🙏</span>
            </td>
          </tr>

          <!-- BOTTOM 3-COLUMN CONTACT DOCK -->
          <tr>
            <td style="background:#f0f6ff; border-top:1px solid #e0edfd; padding:18px 24px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td width="33%" align="center" style="padding:4px 8px; border-right:1px solid #cbdff7;">
                    <div style="font-size:11px; text-transform:uppercase; font-weight:800; color:#0369a1; letter-spacing:0.04em;">
                      🎧 Support
                    </div>
                    <div style="font-size:12px; color:#0f172a; font-weight:600; margin-top:2px; word-break:break-all;">
                      ${supportEmail}
                    </div>
                  </td>
                  <td width="33%" align="center" style="padding:4px 8px; border-right:1px solid #cbdff7;">
                    <div style="font-size:11px; text-transform:uppercase; font-weight:800; color:#0369a1; letter-spacing:0.04em;">
                      📞 Contact Us
                    </div>
                    <div style="font-size:12px; color:#0f172a; font-weight:600; margin-top:2px;">
                      ${supportPhone}
                    </div>
                  </td>
                  <td width="33%" align="center" style="padding:4px 8px;">
                    <div style="font-size:11px; text-transform:uppercase; font-weight:800; color:#0369a1; letter-spacing:0.04em;">
                      🌐 Website
                    </div>
                    <div style="font-size:12px; color:#0f172a; font-weight:600; margin-top:2px;">
                      ${cleanWebsiteUrl}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <!-- /MAIN CONTAINER -->

        <div style="margin-top:14px; font-size:11px; color:#94a3b8; text-align:center;">
          © ${new Date().getFullYear()} ${brand}. Secured Automated Receipt Dispatch.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();

    let rawMessage;
    if (pdfBuffer) {
      const boundary = `boundary_${Date.now().toString(16)}_${Math.random().toString(16).slice(2)}`;
      const pdfBase64 = Buffer.isBuffer(pdfBuffer) ? pdfBuffer.toString('base64') : Buffer.from(pdfBuffer).toString('base64');
      const attachmentName = pdfFileName || `Receipt-${orderId}.pdf`;

      rawMessage = [
        `From: "${brand}" <${sender}>`,
        `To: ${toEmail}`,
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(htmlBody).toString('base64'),
        '',
        `--${boundary}`,
        `Content-Type: application/pdf; name="${attachmentName}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${attachmentName}"`,
        '',
        pdfBase64,
        '',
        `--${boundary}--`
      ].join('\r\n');
    } else {
      rawMessage = [
        `From: "${brand}" <${sender}>`,
        `To: ${toEmail}`,
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(htmlBody).toString('base64')
      ].join('\r\n');
    }

    const encodedMessage = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    try {
      const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ raw: encodedMessage }),
        signal: AbortSignal.timeout(10000)
      });

      if (!sendRes.ok) {
        const errorText = await sendRes.text();
        console.warn('[EmailReceiptService] Gmail send API returned non-OK:', sendRes.status, errorText);
        return { sent: false, reason: 'GMAIL_SEND_ERROR' };
      }

      const sendData = await sendRes.json();
      console.log(`[EmailReceiptService] Receipt replica successfully sent to ${toEmail} (Message ID: ${sendData.id})`);
      return { sent: true, messageId: sendData.id };
    } catch (e) {
      console.warn('[EmailReceiptService] Error delivering receipt:', e.message);
      return { sent: false, reason: e.message };
    }
  }
}
