const nodemailer = require('nodemailer');

// Create transporter - supports Gmail, Google Workspace (psgtech.ac.in), or Ethereal fallback
let transporter = null;

async function getTransporter() {
    if (transporter) return transporter;

    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (user && pass) {
        // Google Workspace / Gmail SMTP
        transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            auth: { user, pass },
            tls: { rejectUnauthorized: false }
        });
        console.log('[EMAIL] Using SMTP for:', user);

        // Verify connection
        try {
            await transporter.verify();
            console.log('[EMAIL] SMTP connection verified successfully!');
        } catch (verifyErr) {
            console.error('[EMAIL] SMTP verification failed:', verifyErr.message);
            console.log('[EMAIL] Trying with less secure settings...');
            // Try alternate config
            transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user, pass },
                tls: { rejectUnauthorized: false }
            });
        }
    } else {
        // Ethereal test account for demo
        try {
            const testAccount = await nodemailer.createTestAccount();
            transporter = nodemailer.createTransport({
                host: 'smtp.ethereal.email',
                port: 587,
                secure: false,
                auth: { user: testAccount.user, pass: testAccount.pass }
            });
            console.log('[EMAIL] Using Ethereal test account:', testAccount.user);
            console.log('[EMAIL] View sent emails at: https://ethereal.email');
        } catch (e) {
            console.log('[EMAIL] Ethereal unavailable, emails will be logged only');
            transporter = {
                sendMail: async (opts) => {
                    console.log('[EMAIL-LOG] To:', opts.to, 'Subject:', opts.subject);
                    return { messageId: 'log-' + Date.now() };
                }
            };
        }
    }
    return transporter;
}

async function sendInvoiceEmail(order) {
    try {
        const t = await getTransporter();
        const gst = Math.round((order.subtotal || order.total_price * 100 / 118) * 18 / 100);
        const subtotal = order.total_price - gst;
        const payIcon = order.payment_method === 'card' ? '💳' : order.payment_method === 'upi' ? '📱' : '💵';

        const html = `
        <div style="font-family:'Segoe UI',Tahoma,sans-serif;max-width:600px;margin:0 auto;background:#0a1a0a;color:#e2e8f0;padding:30px;border-radius:16px">
            <div style="text-align:center;margin-bottom:20px">
                <h1 style="color:#22c55e;margin:0">🌱 GreenCycle</h1>
                <p style="color:#94a3b8;font-size:13px">Tax Invoice / Payment Receipt</p>
            </div>
            <div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);border-radius:12px;padding:16px;margin-bottom:20px">
                <h2 style="color:#22c55e;margin:0 0 4px;font-size:18px">✅ Order Confirmed!</h2>
                <p style="color:#94a3b8;margin:0;font-size:13px">Order #${order.id} · ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</p>
            </div>
            <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
                <tr style="border-bottom:1px solid rgba(255,255,255,.1)">
                    <td style="padding:10px 0;color:#94a3b8">Product</td>
                    <td style="padding:10px 0;text-align:right;font-weight:700">${order.product_name}</td>
                </tr>
                <tr style="border-bottom:1px solid rgba(255,255,255,.1)">
                    <td style="padding:10px 0;color:#94a3b8">Quantity</td>
                    <td style="padding:10px 0;text-align:right;font-weight:700">${order.quantity_kg} kg</td>
                </tr>
                <tr style="border-bottom:1px solid rgba(255,255,255,.1)">
                    <td style="padding:10px 0;color:#94a3b8">Subtotal</td>
                    <td style="padding:10px 0;text-align:right;font-weight:700">₹${subtotal.toLocaleString()}</td>
                </tr>
                <tr style="border-bottom:1px solid rgba(255,255,255,.1)">
                    <td style="padding:10px 0;color:#94a3b8">GST (18%)</td>
                    <td style="padding:10px 0;text-align:right;font-weight:700;color:#3b82f6">₹${gst.toLocaleString()}</td>
                </tr>
                <tr>
                    <td style="padding:14px 0;color:#22c55e;font-size:20px;font-weight:800">Total</td>
                    <td style="padding:14px 0;text-align:right;color:#22c55e;font-size:20px;font-weight:800">₹${order.total_price.toLocaleString()}</td>
                </tr>
            </table>
            <div style="background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.2);border-radius:10px;padding:12px;margin-bottom:16px">
                <span style="font-size:14px">${payIcon} Payment: <strong>${(order.payment_method || 'cod').toUpperCase()}</strong></span>
                <span style="float:right;color:#22c55e;font-weight:700">${order.payment_status === 'paid' ? '✅ Paid' : '⏳ ' + (order.payment_status || 'pending')}</span>
            </div>
            <div style="background:rgba(255,255,255,.03);border-radius:10px;padding:12px;font-size:12px;color:#94a3b8">
                <strong>Shipping To:</strong> ${order.customer_name}<br>
                📍 ${order.customer_address || 'Coimbatore'}<br>
                📞 ${order.customer_phone || 'N/A'}
            </div>
            <div style="text-align:center;margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,.1)">
                <p style="color:#64748b;font-size:11px;margin:0">GreenCycle Waste Management Pvt Ltd · Coimbatore, Tamil Nadu</p>
                <p style="color:#64748b;font-size:11px;margin:4px 0 0">GSTIN: 33ABCDE1234F1Z5 · CIN: U90000TN2024PTC123456</p>
            </div>
        </div>`;

        const info = await t.sendMail({
            from: '"GreenCycle" <invoices@greencycle.com>',
            to: order.customer_email || order.email,
            subject: `🧾 Invoice #${order.id} — ₹${order.total_price.toLocaleString()} | GreenCycle`,
            html
        });

        console.log(`[EMAIL] Invoice sent to ${order.customer_email || order.email}: ${info.messageId}`);
        let previewUrl = '';
        if (info.messageId && nodemailer.getTestMessageUrl) {
            previewUrl = nodemailer.getTestMessageUrl(info) || '';
            if (previewUrl) console.log('[EMAIL] Preview URL:', previewUrl);
        }
        return { success: true, messageId: info.messageId, previewUrl };
    } catch (err) {
        console.error('[EMAIL] Failed to send:', err.message);
        return { success: false, error: err.message, previewUrl: '' };
    }
}

module.exports = { sendInvoiceEmail, getTransporter };
