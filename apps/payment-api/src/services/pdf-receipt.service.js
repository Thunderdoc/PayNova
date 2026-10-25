import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

/**
 * pdf-receipt.service.js
 * Generates vector PDF payment receipts for verified transactions.
 */
export class PdfReceiptService {
  /**
   * Generates a PDF buffer for a verified payment
   * @param {Object} data
   * @returns {Promise<Buffer>}
   */
  async generateReceiptBuffer({
    receiptNumber,
    orderId,
    amount,
    currency = 'INR',
    customerName,
    customerEmail,
    customerPhone,
    paymentMethod = 'UPI',
    utr,
    gatewayName = 'PayNova',
    paidAt,
    businessName = 'PayNova',
    supportEmail = '',
    supportPhone = '',
    websiteUrl = '',
    productName = '',
    productVariant = '',
    items = null
  }) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margin: 36,
          info: {
            Title: `Payment Receipt - ${orderId}`,
            Author: businessName,
            Subject: `Receipt ${receiptNumber}`
          }
        });

        const buffers = [];
        doc.on('data', chunk => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', err => reject(err));

        const pageWidth = 595.28;
        const margin = 36;
        const contentWidth = pageWidth - (margin * 2);

        // Normalize payment method string
        let cleanMethod = paymentMethod || 'UPI';
        cleanMethod = cleanMethod.replace(/^UPI\s*\((.*)\)$/i, '$1').replace(/\bUPI\s*\(\s*UPI\s*\)/i, 'UPI');
        if (cleanMethod === 'UPI') cleanMethod = 'UPI';

        // --- TOP HEADER BAR ---
        doc.rect(margin, margin, contentWidth, 72)
          .fill('#062B63');

        // Draw Hackastra Shield with Capital H on Left
        const shieldX = margin + 16;
        const shieldY = margin + 14;
        const sW = 38;
        const sH = 44;
        doc.save();
        doc.path(`M ${shieldX + sW/2} ${shieldY} L ${shieldX + sW} ${shieldY + 10} L ${shieldX + sW} ${shieldY + 28} Q ${shieldX + sW/2} ${shieldY + sH} ${shieldX + sW/2} ${shieldY + sH} Q ${shieldX} ${shieldY + 28} ${shieldX} ${shieldY + 10} Z`)
          .fill('#0ea5e9');
        doc.path(`M ${shieldX + sW/2} ${shieldY + 2} L ${shieldX + sW - 2} ${shieldY + 11} L ${shieldX + sW - 2} ${shieldY + 27} Q ${shieldX + sW/2} ${shieldY + sH - 2} ${shieldX + sW/2} ${shieldY + sH - 2} Q ${shieldX + 2} ${shieldY + 27} ${shieldX + 2} ${shieldY + 11} Z`)
          .fill('#0284c7');
        doc.fillColor('#ffffff')
          .font('Helvetica-Bold')
          .fontSize(20)
          .text('H', shieldX, shieldY + 12, { width: sW, align: 'center' });
        doc.restore();

        // Company Title & Tagline
        doc.fillColor('#ffffff')
          .font('Helvetica-Bold')
          .fontSize(17)
          .text(businessName.toUpperCase(), margin + 64, margin + 14, { width: 320 });

        doc.font('Helvetica')
          .fontSize(8.5)
          .fillColor('#93c5fd')
          .text('Innovating Today, Empowering Tomorrow', margin + 64, margin + 36);

        doc.font('Helvetica')
          .fontSize(8)
          .fillColor('#cbd5e1')
          .text('Official Payment Confirmation Receipt', margin + 64, margin + 49);

        // PAID BADGE WITH CHECKMARK
        const badgeW = 98;
        const badgeH = 34;
        const badgeX = pageWidth - margin - badgeW - 12;
        const badgeY = margin + 16;
        doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 6)
          .fill('#12B76A');

        doc.fillColor('#ffffff')
          .font('Helvetica-Bold')
          .fontSize(13)
          .text('✓ PAID', badgeX, badgeY + 10, { width: badgeW, align: 'center' });

        doc.fillColor('#94a3b8')
          .font('Helvetica')
          .fontSize(7.5)
          .text('Payment Successful', badgeX, badgeY + 38, { width: badgeW, align: 'center' });

        // --- PAYMENT SUCCESS BANNER ---
        let y = margin + 84;
        doc.roundedRect(margin, y, contentWidth, 44, 8)
          .fillAndStroke('#EAFBF2', '#B7F2D0');

        // Circular Green Check Icon
        doc.circle(margin + 26, y + 22, 12).fill('#12B76A');
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text('✓', margin + 18, y + 16, { width: 16, align: 'center' });

        doc.fillColor('#027A48').font('Helvetica-Bold').fontSize(12)
          .text('Payment Successful!', margin + 48, y + 10);
        doc.fillColor('#05603A').font('Helvetica').fontSize(8.5)
          .text('Your payment has been received and verified successfully.', margin + 48, y + 25);

        // Date right-aligned
        const dateObj = paidAt ? new Date(paidAt) : new Date();
        const dateStr = dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
        const timeStr = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

        doc.fillColor('#027A48').font('Helvetica-Bold').fontSize(8.5)
          .text(`${dateStr}, ${timeStr}`, margin + contentWidth - 180, y + 12, { width: 165, align: 'right' });
        doc.fillColor('#64748b').font('Helvetica').fontSize(7.5)
          .text('Transaction completed', margin + contentWidth - 180, y + 25, { width: 165, align: 'right' });

        // --- SUMMARY STRIP (4 Columns) ---
        y += 54;
        doc.roundedRect(margin, y, contentWidth, 54, 8)
          .fillAndStroke('#ffffff', '#D7E5FA');

        const colW = contentWidth / 4;

        // Receipt No
        doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(7.5)
          .text('RECEIPT NUMBER', margin + 12, y + 11);
        doc.fillColor('#13213A').font('Helvetica-Bold').fontSize(9)
          .text(receiptNumber || 'Not available', margin + 12, y + 26, { width: colW - 14 });

        // Order ID
        doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(7.5)
          .text('ORDER ID', margin + colW + 8, y + 11);
        doc.fillColor('#13213A').font('Helvetica-Bold').fontSize(9)
          .text(orderId ? `#${orderId}` : 'Not available', margin + colW + 8, y + 26, { width: colW - 14 });

        // Payment Date
        doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(7.5)
          .text('PAYMENT DATE', margin + colW * 2 + 8, y + 11);
        doc.fillColor('#13213A').font('Helvetica-Bold').fontSize(9)
          .text(`${dateStr}, ${timeStr}`, margin + colW * 2 + 8, y + 26, { width: colW - 14 });

        // Amount Paid
        const formattedAmount = Number(amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(7.5)
          .text('TOTAL PAID', margin + colW * 3 + 8, y + 11);
        doc.fillColor('#12B76A').font('Helvetica-Bold').fontSize(13)
          .text(`₹${formattedAmount}`, margin + colW * 3 + 8, y + 24);

        // --- BILLING & SETTLEMENT DETAILS (2 Equal Cards) ---
        y += 66;
        const cardW = (contentWidth - 16) / 2;

        // Card 1: Customer Details
        doc.roundedRect(margin, y, cardW, 84, 8).fillAndStroke('#ffffff', '#D7E5FA');

        doc.fillColor('#0866F5').font('Helvetica-Bold').fontSize(9)
          .text('👤  Customer / Billed To', margin + 14, y + 10);
        doc.moveTo(margin + 14, y + 24).lineTo(margin + cardW - 14, y + 24).stroke('#EEF5FF');

        let custY = y + 30;
        doc.fillColor('#64748b').font('Helvetica').fontSize(8.5).text('Name', margin + 14, custY);
        doc.fillColor('#13213A').font('Helvetica-Bold').fontSize(8.5).text(`:  ${customerName || 'Not provided'}`, margin + 60, custY);
        custY += 15;

        doc.fillColor('#64748b').font('Helvetica').fontSize(8.5).text('Phone', margin + 14, custY);
        doc.fillColor('#13213A').font('Helvetica-Bold').fontSize(8.5).text(`:  ${customerPhone || 'Not provided'}`, margin + 60, custY);
        custY += 15;

        doc.fillColor('#64748b').font('Helvetica').fontSize(8.5).text('Email', margin + 14, custY);
        doc.fillColor('#13213A').font('Helvetica-Bold').fontSize(8.5).text(`:  ${customerEmail || 'Not provided'}`, margin + 60, custY);

        // Card 2: Payment Details
        const rightCardX = margin + cardW + 16;
        doc.roundedRect(rightCardX, y, cardW, 84, 8).fillAndStroke('#ffffff', '#D7E5FA');

        doc.fillColor('#0866F5').font('Helvetica-Bold').fontSize(9)
          .text('💳  Payment Details', rightCardX + 14, y + 10);
        doc.moveTo(rightCardX + 14, y + 24).lineTo(rightCardX + cardW - 14, y + 24).stroke('#EEF5FF');

        let settlY = y + 30;
        doc.fillColor('#64748b').font('Helvetica').fontSize(8.5).text('Payment Method', rightCardX + 14, settlY);
        doc.fillColor('#13213A').font('Helvetica-Bold').fontSize(8.5).text(`:  ${cleanMethod}`, rightCardX + 95, settlY);
        settlY += 15;

        doc.fillColor('#64748b').font('Helvetica').fontSize(8.5).text('Bank Ref / UTR', rightCardX + 14, settlY);
        doc.fillColor('#13213A').font('Helvetica-Bold').fontSize(8.5).text(`:  ${utr || 'Not available'}`, rightCardX + 95, settlY);
        settlY += 15;

        doc.fillColor('#64748b').font('Helvetica').fontSize(8.5).text('Verification', rightCardX + 14, settlY);
        doc.fillColor('#12B76A').font('Helvetica-Bold').fontSize(8.5).text(':  ✓ Server-Side Verified (Instant)', rightCardX + 95, settlY);

        // --- ORDER DETAILS TABLE ---
        y += 96;

        // Table Header Row
        doc.roundedRect(margin, y, contentWidth, 24, 4).fill('#062B63');
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8)
          .text('ITEM', margin + 14, y + 7);
        doc.text('QTY', margin + 310, y + 7, { width: 40, align: 'center' });
        doc.text('RATE', margin + 360, y + 7, { width: 65, align: 'right' });
        doc.text('AMOUNT', margin + 435, y + 7, { width: 75, align: 'right' });

        y += 24;

        // Line Items
        const orderItems = (items && items.length > 0) ? items : [{
          name: productName || 'Payment for order',
          variant: productVariant || (orderId ? `Order #${orderId}` : ''),
          orderDesc: orderId ? `Payment for Order #${orderId}` : 'Payment for order',
          qty: 1,
          rate: formattedAmount,
          amount: formattedAmount
        }];

        for (const item of orderItems) {
          doc.rect(margin, y, contentWidth, 42).fillAndStroke('#ffffff', '#EEF5FF');

          doc.fillColor('#13213A').font('Helvetica-Bold').fontSize(9)
            .text(item.name || productName, margin + 14, y + 8, { width: 280 });
          doc.fillColor('#64748b').font('Helvetica').fontSize(7.5)
            .text(item.variant || item.orderDesc || '', margin + 14, y + 22, { width: 280 });

          doc.fillColor('#13213A').font('Helvetica').fontSize(8.5)
            .text(String(item.qty || 1), margin + 310, y + 14, { width: 40, align: 'center' });
          doc.text(`₹${item.rate || formattedAmount}`, margin + 360, y + 14, { width: 65, align: 'right' });
          doc.font('Helvetica-Bold')
            .text(`₹${item.amount || formattedAmount}`, margin + 435, y + 14, { width: 75, align: 'right' });

          y += 42;
        }

        // --- FINANCIAL SUMMARY & NOTES ROW ---
        const sumW = 220;
        const notesW = contentWidth - sumW - 14;

        // Left: Notes Panel
        doc.rect(margin, y + 6, notesW, 60).fill('#f0f9ff');
        doc.rect(margin, y + 6, notesW, 60).stroke('#bae6fd');
        doc.fillColor('#0369a1').font('Helvetica-Bold').fontSize(9)
          .text('Notes', margin + 12, y + 14);
        doc.fillColor('#475569').font('Helvetica').fontSize(8.5)
          .text('This receipt was generated electronically from the transaction information recorded by PayNova. Please retain it for your records.', margin + 12, y + 28, { width: notesW - 24, lineGap: 2 });

        // Right: Financial Totals Box
        const sumX = margin + notesW + 14;
        doc.rect(sumX, y + 6, sumW, 60).fill('#f8fafc');
        doc.rect(sumX, y + 6, sumW, 60).stroke('#e2e8f0');

        doc.fillColor('#64748b').font('Helvetica').fontSize(8.5)
          .text('Subtotal:', sumX + 12, y + 14);
        doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8.5)
          .text(`₹${formattedAmount}`, sumX + 120, y + 14, { width: 88, align: 'right' });

        doc.fillColor('#64748b').font('Helvetica').fontSize(8.5)
          .text('GST / Taxes (Inclusive):', sumX + 12, y + 28);
        doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8.5)
          .text('Not provided', sumX + 120, y + 28, { width: 88, align: 'right' });

        doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10)
          .text('Total Paid:', sumX + 12, y + 44);
        doc.fillColor('#10b981').font('Helvetica-Bold').fontSize(11)
          .text(`₹${formattedAmount}`, sumX + 120, y + 43, { width: 88, align: 'right' });

        // --- THANK YOU BANNER ---
        y += 78;
        doc.rect(margin, y, contentWidth, 42).fill('#f0fdf4');
        doc.rect(margin, y, contentWidth, 42).stroke('#bbf7d0');

        doc.fillColor('#15803d').font('Helvetica-Bold').fontSize(11)
          .text('Thank you for your payment!', margin + 16, y + 10);
        doc.fillColor('#166534').font('Helvetica').fontSize(9)
          .text(`We appreciate your trust in ${businessName}.`, margin + 16, y + 25);

        // --- FOOTER DOCK (3 Columns) ---
        const footerY = 690;
        doc.moveTo(margin, footerY).lineTo(pageWidth - margin, footerY).stroke('#cbd5e1');

        const footColW = contentWidth / 3;
        // Col 1: Need Help?
        doc.fillColor('#0369a1').font('Helvetica-Bold').fontSize(8.5)
          .text('Need Help?', margin, footerY + 12, { width: footColW, align: 'left' });
        doc.fillColor('#475569').font('Helvetica').fontSize(8)
          .text(supportEmail, margin, footerY + 24, { width: footColW, align: 'left' });
        doc.text(supportPhone, margin, footerY + 36, { width: footColW, align: 'left' });

        // Col 2: Website
        doc.fillColor('#0369a1').font('Helvetica-Bold').fontSize(8.5)
          .text('Visit Our Website', margin + footColW, footerY + 12, { width: footColW, align: 'center' });
        doc.fillColor('#475569').font('Helvetica').fontSize(8)
          .text(websiteUrl, margin + footColW, footerY + 24, { width: footColW, align: 'center' });
        doc.text('24/7 Verified Gateway Support', margin + footColW, footerY + 36, { width: footColW, align: 'center' });

        // Col 3: Company Info
        doc.fillColor('#0369a1').font('Helvetica-Bold').fontSize(8.5)
          .text(businessName, margin + footColW * 2, footerY + 12, { width: footColW, align: 'right' });
        doc.fillColor('#475569').font('Helvetica').fontSize(8)
          .text('Payment processing support', margin + footColW * 2, footerY + 24, { width: footColW, align: 'right' });
        doc.text(`© ${dateObj.getFullYear()} All rights reserved`, margin + footColW * 2, footerY + 36, { width: footColW, align: 'right' });

        doc.fillColor('#94a3b8').font('Helvetica').fontSize(7.5)
          .text('This is an electronically generated payment receipt. Please retain it for your records.', margin, footerY + 54, { align: 'center', width: contentWidth });

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Generates a high-resolution printable A4 counter standee (PDF)
   * With Hackastra Private Limited branding, QR scan frame, and supported UPI apps
   * @param {Object} data
   * @returns {Promise<Buffer>}
   */
  async generateStandeeBuffer({
    merchantName = 'PayNova',
    upiId,
    tagline = 'Scan & Pay with Any UPI App',
    supportPhone = '+91 7092620770',
    websiteUrl = '',
    primaryColor = '#0866FF'
  }) {
    if (!upiId || !/^[^@\s]+@[^@\s]+$/.test(String(upiId))) {
      throw new Error('A valid receiving UPI ID is required to generate the standee');
    }
    return new Promise(async (resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margin: 40,
          info: {
            Title: `Official UPI Counter Standee - ${merchantName}`,
            Author: merchantName,
            Subject: 'Counter Standee'
          }
        });

        const buffers = [];
        doc.on('data', chunk => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', err => reject(err));

        const pageWidth = 595.28;
        const pageHeight = 841.89;
        const margin = 24;
        const contentWidth = pageWidth - (margin * 2);
        const navy = '#062454';
        const blue = /^#[0-9a-f]{6}$/i.test(primaryColor) ? primaryColor : '#0866FF';
        const upiUri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(merchantName)}&cu=INR`;
        const qrPng = Buffer.from((await QRCode.toDataURL(upiUri, { errorCorrectionLevel: 'H', margin: 2, width: 900 })).split(',')[1], 'base64');

        doc.rect(margin, margin, contentWidth, 112).fill(navy);
        doc.circle(margin + 54, margin + 56, 26).fill(blue);
        doc.fillColor('#fff').font('Helvetica-Bold').fontSize(28).text('H', margin + 44, margin + 38, { width: 20, align: 'center' });

        doc.fillColor('#ffffff')
          .font('Helvetica-Bold')
          .fontSize(22)
          .text(merchantName, margin + 92, margin + 30, { width: contentWidth - 110 });

        doc.fillColor('#93c5fd')
          .font('Helvetica')
          .fontSize(13)
          .text(tagline, margin + 92, margin + 64, { width: contentWidth - 110 });

        // QR Frame Box (Center)
        const frameW = 430;
        const frameH = 570;
        const frameX = (pageWidth - frameW) / 2;
        const frameY = margin + 140;

        doc.roundedRect(frameX, frameY, frameW, frameH, 16).fillAndStroke('#ffffff', '#cbdcf5');

        doc.fillColor('#0f172a')
          .font('Helvetica-Bold')
          .fontSize(17)
          .text('ALL UPI APPS ACCEPTED HERE', frameX, frameY + 24, { align: 'center', width: frameW });

        const qrSize = 245;
        const qrX = (pageWidth - qrSize) / 2;
        doc.roundedRect(qrX - 14, frameY + 58, qrSize + 28, qrSize + 28, 12).fill('#f8fbff');
        doc.image(qrPng, qrX, frameY + 72, { width: qrSize, height: qrSize });
        doc.fillColor('#36527d').font('Helvetica').fontSize(13).text('Scan this QR code to pay', frameX, frameY + 338, { align: 'center', width: frameW });

        // VPA Air Copy Dock Box
        doc.roundedRect(frameX + 30, frameY + 375, frameW - 60, 66, 8)
          .fill('#eff6ff');

        doc.fillColor('#64748b')
          .font('Helvetica')
          .fontSize(9.5)
          .text('UPI ID / VPA', frameX + 48, frameY + 387, { width: 120 });

        doc.fillColor('#0f172a')
          .font('Helvetica-Bold')
          .fontSize(14)
          .text(upiId, frameX + 48, frameY + 407, { width: frameW - 130 });

        // Supported Apps Dock
        const dockY = frameY + frameH + 18;
        doc.fillColor('#475569')
          .font('Helvetica-Bold')
          .fontSize(12)
          .text('Google Pay  •  PhonePe  •  Paytm  •  CRED  •  BHIM UPI', margin, dockY, { align: 'center', width: contentWidth });

        // Footer Support Dock
        doc.rect(0, pageHeight - 58, pageWidth, 58).fill(navy);

        doc.fillColor('#ffffff')
          .font('Helvetica')
          .fontSize(9)
          .text(`Secure UPI payment processing  •  Verified payment status  •  Support: ${supportPhone}${websiteUrl ? `  •  ${websiteUrl}` : ''}`, margin, pageHeight - 35, { align: 'center', width: contentWidth });

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}

export const pdfReceiptService = new PdfReceiptService();
