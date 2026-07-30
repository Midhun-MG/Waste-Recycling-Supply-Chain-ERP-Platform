const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb, saveDatabase } = require('../database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole('admin'));

// Dashboard stats
router.get('/stats', async (req, res) => {
    try {
        const pool = getDb();
        const totalUsers = await pool.query("SELECT COUNT(*) as c FROM users");
        const totalClients = await pool.query("SELECT COUNT(*) as c FROM users WHERE role = 'client'");
        const totalDrivers = await pool.query("SELECT COUNT(*) as c FROM users WHERE role = 'driver'");
        const totalPickups = await pool.query("SELECT COUNT(*) as c FROM pickup_requests");
        const completedPickups = await pool.query("SELECT COUNT(*) as c FROM pickup_requests WHERE status = 'completed'");
        const totalKg = await pool.query("SELECT COALESCE(SUM(quantity_kg), 0) as c FROM pickup_requests WHERE status = 'completed'");

        res.json({
            stats: {
                totalUsers: parseInt(totalUsers.rows[0].c) || 0,
                totalClients: parseInt(totalClients.rows[0].c) || 0,
                totalDrivers: parseInt(totalDrivers.rows[0].c) || 0,
                totalPickups: parseInt(totalPickups.rows[0].c) || 0,
                completedPickups: parseInt(completedPickups.rows[0].c) || 0,
                totalKgCollected: parseFloat(totalKg.rows[0].c) || 0
            }
        });
    } catch (err) {
        console.error('Admin stats error:', err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// All users
router.get('/users', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query("SELECT id, name, email, role, phone, shop_name, address, pincode, vehicle_type, zone, is_free, created_at FROM users ORDER BY id");
        res.json({ users: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Create user
router.post('/users', async (req, res) => {
    try {
        const pool = getDb();
        const { name, email, password, role, phone, shop_name, address, pincode, vehicle_type, vehicle_capacity_kg, zone } = req.body;

        if (!name || !email || !password || !role) {
            return res.status(400).json({ error: 'Name, email, password, and role are required' });
        }

        const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already exists' });
        }

        const hashedPassword = bcrypt.hashSync(password, 10);
        const result = await pool.query(
            `INSERT INTO users (name, email, password, role, phone, shop_name, address, pincode, vehicle_type, vehicle_capacity_kg, zone) 
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [name, email, hashedPassword, role, phone || null, shop_name || null, address || null, pincode || null, vehicle_type || null, vehicle_capacity_kg || 0, zone || null]
        );

        res.json({ message: 'User created successfully', user_id: result.rows[0].id });
    } catch (err) {
        console.error('Create user error:', err);
        res.status(500).json({ error: 'Failed to create user' });
    }
});

// Delete user
router.delete('/users/:id', async (req, res) => {
    try {
        const pool = getDb();
        await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
        res.json({ message: 'User deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// All pickup requests
router.get('/pickups', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT pr.*, c.name as client_name, c.shop_name, d.name as driver_name
            FROM pickup_requests pr
            LEFT JOIN users c ON pr.client_id = c.id
            LEFT JOIN users d ON pr.driver_id = d.id
            ORDER BY pr.created_at DESC
        `);
        res.json({ pickups: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch pickups' });
    }
});

// Get settings
router.get('/settings', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query("SELECT * FROM admin_settings ORDER BY id");
        const settings = {};
        result.rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
        res.json({ settings });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// Update setting
router.put('/settings/:key', async (req, res) => {
    try {
        const pool = getDb();
        const { value } = req.body;
        const existing = await pool.query("SELECT id FROM admin_settings WHERE setting_key = $1", [req.params.key]);
        if (existing.rows.length > 0) {
            await pool.query("UPDATE admin_settings SET setting_value = $1, updated_at = NOW() WHERE setting_key = $2", [value, req.params.key]);
        } else {
            await pool.query("INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)", [req.params.key, value]);
        }
        res.json({ message: 'Setting updated' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update setting' });
    }
});

// ===== CUSTOMER FEEDBACK =====
router.get('/feedback', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query("SELECT * FROM customer_feedback ORDER BY created_at DESC");
        res.json({ feedback: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch feedback' });
    }
});

router.put('/feedback/:id/reply', async (req, res) => {
    try {
        const pool = getDb();
        const { reply } = req.body;
        await pool.query("UPDATE customer_feedback SET admin_reply = $1, status = 'resolved' WHERE id = $2", [reply, req.params.id]);
        res.json({ message: 'Reply sent' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to send reply' });
    }
});

// ===== PIPELINE OVERVIEW =====
router.get('/pipeline', async (req, res) => {
    try {
        const pool = getDb();
        // Pickups
        const pPending = await pool.query("SELECT COUNT(*) as c FROM pickup_requests WHERE status = 'pending'");
        const pAssigned = await pool.query("SELECT COUNT(*) as c FROM pickup_requests WHERE status = 'assigned'");
        const pTransit = await pool.query("SELECT COUNT(*) as c FROM pickup_requests WHERE status = 'in_transit'");
        const pCompleted = await pool.query("SELECT COUNT(*) as c FROM pickup_requests WHERE status IN ('completed','delivered')");
        // Inventory
        const iReceived = await pool.query("SELECT COUNT(*) as c FROM inventory WHERE status = 'received'");
        const iProcessing = await pool.query("SELECT COUNT(*) as c FROM inventory WHERE status = 'processing'");
        const iProcessed = await pool.query("SELECT COUNT(*) as c FROM inventory WHERE status = 'processed'");
        const iTotalKg = await pool.query("SELECT COALESCE(SUM(quantity_kg),0) as c FROM inventory");
        // Production
        const prPending = await pool.query("SELECT COUNT(*) as c FROM production_orders WHERE status = 'pending'");
        const prInProd = await pool.query("SELECT COUNT(*) as c FROM production_orders WHERE status = 'in_production'");
        const prCompleted = await pool.query("SELECT COUNT(*) as c FROM production_orders WHERE status = 'completed'");
        const prCost = await pool.query("SELECT COALESCE(SUM(material_cost),0) as c FROM production_orders");
        const prRevenue = await pool.query("SELECT COALESCE(SUM(estimated_selling_price),0) as c FROM production_orders");
        // Packing
        const pkPending = await pool.query("SELECT COUNT(*) as c FROM packing_orders WHERE status = 'pending'");
        const pkPacking = await pool.query("SELECT COUNT(*) as c FROM packing_orders WHERE status = 'packing'");
        const pkPacked = await pool.query("SELECT COUNT(*) as c FROM packing_orders WHERE status = 'packed'");
        const pkDispatched = await pool.query("SELECT COUNT(*) as c FROM packing_orders WHERE status = 'dispatched'");
        // Settings
        const settings = await pool.query("SELECT * FROM admin_settings");
        const settingsObj = {};
        settings.rows.forEach(r => { settingsObj[r.setting_key] = r.setting_value; });

        res.json({
            pipeline: {
                pickups: { pending: parseInt(pPending.rows[0].c), assigned: parseInt(pAssigned.rows[0].c), in_transit: parseInt(pTransit.rows[0].c), completed: parseInt(pCompleted.rows[0].c) },
                inventory: { received: parseInt(iReceived.rows[0].c), processing: parseInt(iProcessing.rows[0].c), processed: parseInt(iProcessed.rows[0].c), total_kg: parseFloat(iTotalKg.rows[0].c) },
                production: { pending: parseInt(prPending.rows[0].c), in_production: parseInt(prInProd.rows[0].c), completed: parseInt(prCompleted.rows[0].c), total_material_cost: parseFloat(prCost.rows[0].c), total_estimated_revenue: parseFloat(prRevenue.rows[0].c) },
                packing: { pending: parseInt(pkPending.rows[0].c), packing: parseInt(pkPacking.rows[0].c), packed: parseInt(pkPacked.rows[0].c), dispatched: parseInt(pkDispatched.rows[0].c) }
            },
            settings: settingsObj
        });
    } catch (err) {
        console.error('Pipeline error:', err);
        res.status(500).json({ error: 'Failed to fetch pipeline' });
    }
});

// ===== PRODUCTION ORDERS (admin view) =====
router.get('/production', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT po.*, u.name as created_by_name
            FROM production_orders po
            LEFT JOIN users u ON po.created_by = u.id
            ORDER BY po.created_at DESC
        `);
        res.json({ orders: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch production orders' });
    }
});

// ===== PACKING ORDERS (admin view) =====
router.get('/packing', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT po.*, prod.item_name as source_raw_item, prod.material_cost, prod.estimated_selling_price
            FROM packing_orders po
            LEFT JOIN production_orders prod ON po.production_order_id = prod.id
            ORDER BY po.created_at DESC
        `);
        res.json({ orders: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch packing orders' });
    }
});

// ===== COST ANALYSIS =====
router.get('/costs', async (req, res) => {
    try {
        const pool = getDb();
        const invResult = await pool.query("SELECT setting_value FROM admin_settings WHERE setting_key = 'base_investment'");
        const baseInvestment = invResult.rows.length > 0 ? parseFloat(invResult.rows[0].setting_value) : 50000;
        const costResult = await pool.query("SELECT COALESCE(SUM(material_cost),0) as c FROM production_orders");
        const revResult = await pool.query("SELECT COALESCE(SUM(estimated_selling_price),0) as c FROM production_orders");
        const totalCost = parseFloat(costResult.rows[0].c);
        const totalRevenue = parseFloat(revResult.rows[0].c);
        const netProfit = totalRevenue - totalCost;
        const roi = baseInvestment > 0 ? Math.round((netProfit / baseInvestment) * 100) : 0;

        const breakdown = await pool.query("SELECT item_name, predicted_product, total_kg, material_cost, estimated_selling_price, status FROM production_orders ORDER BY created_at DESC");

        res.json({ base_investment: baseInvestment, total_material_cost: totalCost, total_estimated_revenue: totalRevenue, net_profit: netProfit, roi_percentage: roi, breakdown: breakdown.rows });
    } catch (err) {
        console.error('Costs error:', err);
        res.status(500).json({ error: 'Failed to fetch costs' });
    }
});

// ===== DATABASE TABLE VIEWER =====
router.get('/database/tables', async (req, res) => {
    try {
        const pool = getDb();
        const result = await pool.query(`
            SELECT table_name as name FROM information_schema.tables 
            WHERE table_schema = 'public' ORDER BY table_name
        `);
        const tables = [];
        for (const row of result.rows) {
            const countResult = await pool.query(`SELECT COUNT(*) as c FROM "${row.name}"`);
            tables.push({ name: row.name, row_count: parseInt(countResult.rows[0].c) });
        }
        res.json({ tables });
    } catch (err) {
        console.error('DB tables error:', err);
        res.status(500).json({ error: 'Failed to fetch tables' });
    }
});

router.get('/database/table/:name', async (req, res) => {
    try {
        const pool = getDb();
        const tableName = req.params.name.replace(/[^a-z_]/g, ''); // sanitize
        const countResult = await pool.query(`SELECT COUNT(*) as c FROM "${tableName}"`);
        const total = parseInt(countResult.rows[0].c);
        const result = await pool.query(`SELECT * FROM "${tableName}" ORDER BY 1 LIMIT 100`);
        const columns = result.fields.map(f => f.name);
        res.json({ rows: result.rows, columns, total });
    } catch (err) {
        console.error('DB table error:', err);
        res.status(500).json({ error: 'Failed to fetch table data' });
    }
});

// ===== FEEDBACK: Mark as Read =====
router.put('/feedback/:id/read', async (req, res) => {
    try {
        const pool = getDb();
        await pool.query("UPDATE customer_feedback SET status = 'read' WHERE id = $1", [req.params.id]);
        res.json({ message: 'Marked as read' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update feedback' });
    }
});

// ===== FEEDBACK: Resolve =====
router.put('/feedback/:id/resolve', async (req, res) => {
    try {
        const pool = getDb();
        const { reply } = req.body;
        await pool.query("UPDATE customer_feedback SET admin_reply = $1, status = 'resolved' WHERE id = $2", [reply || '', req.params.id]);
        res.json({ message: 'Feedback resolved' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to resolve feedback' });
    }
});

module.exports = router;
