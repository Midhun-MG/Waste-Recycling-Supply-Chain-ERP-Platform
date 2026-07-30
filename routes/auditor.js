const express = require('express');
const { getDb, saveDatabase } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendInvoiceEmail } = require('../utils/email_invoice');

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole('auditor'));

// ===== DASHBOARD STATS =====
router.get('/stats', async (req, res) => {
    try {
        const pool = getDb();
        const totalInvoices = await pool.query("SELECT COUNT(*) as c FROM invoices");
        const paid = await pool.query("SELECT COUNT(*) as c FROM invoices WHERE payment_status='paid'");
        const unpaid = await pool.query("SELECT COUNT(*) as c FROM invoices WHERE payment_status='unpaid'");
        const totalRevenue = await pool.query("SELECT COALESCE(SUM(total_amount),0) as c FROM invoices WHERE payment_status='paid'");
        const pendingApproval = await pool.query("SELECT COUNT(*) as c FROM sales_orders WHERE status='approved'");
        const taxCollected = await pool.query("SELECT COALESCE(SUM(tax_amount),0) as c FROM invoices WHERE payment_status='paid'");
        res.json({ stats: { total_invoices: parseInt(totalInvoices.rows[0].c), paid: parseInt(paid.rows[0].c), unpaid: parseInt(unpaid.rows[0].c), total_revenue: parseFloat(totalRevenue.rows[0].c), pending_invoice: parseInt(pendingApproval.rows[0].c), tax_collected: parseFloat(taxCollected.rows[0].c) } });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch stats' }); }
});

// ===== PENDING =====
router.get('/pending', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT so.*, u.name as sales_person_name
            FROM sales_orders so
            LEFT JOIN users u ON so.sales_person_id = u.id
            WHERE so.status = 'approved'
            ORDER BY so.created_at ASC
        `);
        res.json({ orders: result.rows });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch pending orders' }); }
});

// ===== GENERATE INVOICE =====
router.post('/generate-invoice', async (req, res) => {
    try {
        const pool = getDb();
        const { sales_order_id, tax_percent, notes } = req.body;
        if (!sales_order_id) return res.status(400).json({ error: 'Sales order ID required' });

        const so = await pool.query("SELECT * FROM sales_orders WHERE id = $1", [sales_order_id]);
        if (so.rows.length === 0) return res.status(404).json({ error: 'Sales order not found' });
        const order = so.rows[0];

        if (order.status !== 'approved') return res.status(400).json({ error: 'Order must be approved by warehouse first' });

        const existing = await pool.query("SELECT id FROM invoices WHERE sales_order_id = $1", [sales_order_id]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Invoice already exists for this order' });
        }

        const taxPct = tax_percent || 18;
        const subtotal = order.total_price;
        const taxAmount = Math.round(subtotal * taxPct / 100);
        const totalAmount = subtotal + taxAmount;

        const countResult = await pool.query("SELECT COUNT(*) as c FROM invoices");
        const count = (parseInt(countResult.rows[0].c) || 0) + 1;
        const invoiceNo = `INV-2026-${String(count).padStart(3, '0')}`;

        await pool.query(
            `INSERT INTO invoices (invoice_no, sales_order_id, customer_name, customer_address, product_name, quantity_kg, unit_price, subtotal, tax_percent, tax_amount, total_amount, auditor_id, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [invoiceNo, sales_order_id, order.customer_name, order.customer_address, order.product_name,
                order.quantity_kg, order.unit_price, subtotal, taxPct, taxAmount, totalAmount, req.user.id, notes || '']
        );

        await pool.query("UPDATE sales_orders SET status = 'invoiced', updated_at = NOW() WHERE id = $1", [sales_order_id]);

        const io = req.app.get('io');
        if (io) {
            io.to('sales_team').emit('invoice_generated', {
                invoiceNo, orderId: sales_order_id, totalAmount,
                message: `Invoice ${invoiceNo} generated for ${order.product_name} - Total: ₹${totalAmount}`
            });
        }

        // Send invoice email to customer
        let customerEmail = '';
        let emailPreviewUrl = '';
        if (order.customer_order_id) {
            const coResult = await pool.query("SELECT customer_email FROM customer_orders WHERE id = $1", [order.customer_order_id]);
            if (coResult.rows.length > 0) {
                customerEmail = coResult.rows[0].customer_email || '';
            }
        }
        if (customerEmail) {
            try {
                const emailResult = await sendInvoiceEmail({
                    id: invoiceNo, product_name: order.product_name, quantity_kg: order.quantity_kg,
                    subtotal, total_price: totalAmount, payment_method: 'invoice', payment_status: 'invoiced',
                    customer_name: order.customer_name, customer_phone: order.customer_phone || '',
                    customer_address: order.customer_address || '', customer_email: customerEmail
                });
                emailPreviewUrl = emailResult.previewUrl || '';
                console.log(`[AUDITOR] Invoice ${invoiceNo} emailed to ${customerEmail}${emailPreviewUrl ? ' — Preview: ' + emailPreviewUrl : ''}`);
            } catch (e) { console.error('[AUDITOR EMAIL] Error:', e.message); }
        }

        res.json({
            message: `Invoice ${invoiceNo} generated! Total: ₹${totalAmount}${customerEmail ? ' — Invoice emailed to ' + customerEmail : ''}`,
            invoice_no: invoiceNo, total_amount: totalAmount,
            email_sent: !!customerEmail, customer_email: customerEmail,
            email_preview_url: emailPreviewUrl
        });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to generate invoice' }); }
});

// ===== MARK INVOICE AS PAID =====
router.put('/invoice/:id/mark-paid', async (req, res) => {
    try {
        const pool = getDb();
        const { payment_method } = req.body;
        if (!payment_method) return res.status(400).json({ error: 'Payment method required (card, upi, bank_transfer)' });

        const inv = await pool.query("SELECT * FROM invoices WHERE id = $1", [req.params.id]);
        if (inv.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
        const invoice = inv.rows[0];

        if (invoice.payment_status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });

        await pool.query("UPDATE invoices SET payment_status = 'paid', payment_method = $1, payment_date = NOW() WHERE id = $2",
            [payment_method, req.params.id]);

        await pool.query("UPDATE sales_orders SET status = 'paid', updated_at = NOW() WHERE id = $1", [invoice.sales_order_id]);

        const io = req.app.get('io');
        if (io) {
            io.to('warehouse_manager').emit('payment_received', {
                invoiceNo: invoice.invoice_no, orderId: invoice.sales_order_id,
                message: `Payment received for ${invoice.invoice_no}! Ready to dispatch ${invoice.product_name}.`
            });
            io.to('sales_team').emit('payment_received', {
                message: `Payment confirmed for ${invoice.invoice_no} (₹${invoice.total_amount}) via ${payment_method}`
            });
        }

        res.json({ message: `Payment confirmed! Order ready for dispatch.`, invoice_no: invoice.invoice_no });
    } catch (err) { res.status(500).json({ error: 'Failed to mark payment' }); }
});

// ===== ALL INVOICES =====
router.get('/invoices', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT i.*, so.status as order_status, u.name as auditor_name
            FROM invoices i
            LEFT JOIN sales_orders so ON i.sales_order_id = so.id
            LEFT JOIN users u ON i.auditor_id = u.id
            ORDER BY i.created_at DESC
        `);
        res.json({ invoices: result.rows });
    } catch (err) { res.status(500).json({ error: 'Failed to fetch invoices' }); }
});

module.exports = router;
