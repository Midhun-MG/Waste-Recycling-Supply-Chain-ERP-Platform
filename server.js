const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
require('dotenv').config();
const { initDatabase, getDb, saveDatabase } = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('io', io);

// ===== ROUTES =====
app.use('/api/auth', require('./routes/auth'));
app.use('/api/client', require('./routes/client'));
app.use('/api/driver', require('./routes/driver'));
app.use('/api/vm', require('./routes/vehicle_manager'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/production', require('./routes/production'));
app.use('/api/packing', require('./routes/packing'));
app.use('/api/packing-manager', require('./routes/packing_manager'));
app.use('/api/warehouse', require('./routes/warehouse'));
app.use('/api/customer', require('./routes/customer'));
app.use('/api/sales-driver', require('./routes/sales_driver'));
app.use('/api/sales-team', require('./routes/sales_team'));
app.use('/api/auditor', require('./routes/auditor'));

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
    console.log(`[SOCKET] Connected: ${socket.id}`);
    socket.on('join', (data) => {
        socket.join(data.role);
        if (data.zone) socket.join(`zone_${data.zone}`);
    });
    socket.on('disconnect', () => { });
});

// ===== AUTO-PIPELINE TIMER =====
// Checks every 30s: auto-complete expired production orders -> create packing -> assign packer
const DEMO_SPEED = 360; // 1h production = 10s real time

setInterval(async () => {
    try {
        const pool = getDb();
        if (!pool) return;

        // 1. Auto-complete expired production orders
        // PostgreSQL: use EXTRACT(EPOCH FROM ...) instead of julianday
        const expired = await pool.query(`
            SELECT * FROM production_orders 
            WHERE status = 'in_production' AND started_at IS NOT NULL 
            AND (EXTRACT(EPOCH FROM (NOW() - started_at)) / 3600) * ${DEMO_SPEED} >= estimated_hours
        `);

        if (expired.rows.length > 0) {
            for (const o of expired.rows) {
                // Complete production
                await pool.query("UPDATE production_orders SET status = 'completed', updated_at = NOW() WHERE id = $1", [o.id]);

                // Free production employee
                if (o.assigned_employee_id) {
                    await pool.query("UPDATE users SET is_free = 1 WHERE id = $1", [o.assigned_employee_id]);
                }

                // Create packing order
                const outputKg = Math.round(o.total_kg * 0.6 * 10) / 10;
                const totalItems = Math.max(100, Math.round(outputKg * 10));
                const itemsPerBox = 100;

                // Find free packing employee
                const freePacker = await pool.query("SELECT id, name FROM users WHERE role = 'packing_employee' AND is_free = 1 LIMIT 1");
                let packerId = null;
                let packerName = 'Unassigned';
                if (freePacker.rows.length > 0) {
                    packerId = freePacker.rows[0].id;
                    packerName = freePacker.rows[0].name;
                    await pool.query("UPDATE users SET is_free = 0 WHERE id = $1", [packerId]);
                }

                await pool.query(
                    "INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item, assigned_employee_id, total_items, items_per_box, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')",
                    [o.id, o.predicted_product, outputKg, o.item_name, packerId, totalItems, itemsPerBox]
                );

                // Update inventory
                await pool.query("UPDATE inventory SET status = 'processed', updated_at = NOW() WHERE LOWER(TRIM(item_name)) = $1",
                    [o.item_name.toLowerCase().trim()]);

                console.log(`[AUTO] Production "${o.predicted_product}" DONE -> Packing (${outputKg}kg) -> Packer: ${packerName}`);
            }

            io.emit('production_completed', {
                count: expired.rows.length,
                message: `${expired.rows.length} production order(s) completed and sent to packing!`
            });
            io.to('packing_employee').emit('new_packing_task', { message: 'New packing task assigned to you!' });
        }
    } catch (err) {
        // Silent timer
    }
}, 30000);

// ===== THRESHOLD AUTO-PRODUCTION TIMER =====
const vmModule = require('./routes/vehicle_manager');
const thresholdInterval = Math.round(3600000 / DEMO_SPEED);
setInterval(() => {
    if (vmModule.checkThresholdProduction) {
        vmModule.checkThresholdProduction(io);
    }
}, thresholdInterval);
// Also run once on startup after 10s
setTimeout(() => {
    if (vmModule.checkThresholdProduction) {
        vmModule.checkThresholdProduction(io);
    }
}, 10000);

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
    server.listen(PORT, () => {
        console.log('');
        console.log('========================================');
        console.log('    GreenCycle ERP - Full Platform');
        console.log('========================================');
        console.log(`  Server: http://localhost:${PORT}`);
        console.log(`  Database: PostgreSQL (${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5433'})`);
        console.log(`  Demo Speed: ${DEMO_SPEED}x (1h = ${Math.round(3600 / DEMO_SPEED)}s real)`);
        console.log('');
        console.log('  ROLES & LOGINS:');
        console.log('  Shop Owner: ravi@shop.com / password123');
        console.log('  Driver: suresh@driver.com / password123');
        console.log('  Vehicle Manager: vikram@manager.com / password123');
        console.log('  Admin: admin@greencycle.com / password123');
        console.log('  Production: prod1@gc.com / password123');
        console.log('  Prod Manager: prodmgr@gc.com / password123');
        console.log('  Packing: pack1@gc.com / password123');
        console.log('  Pack Manager: packmgr@gc.com / password123');
        console.log('  WH Driver: whdriver1@gc.com / password123');
        console.log('  WH Manager: warehouse@gc.com / password123');
        console.log('  Sales Driver: sales1@gc.com / password123');
        console.log('  Customer: customer1@gc.com / password123');
        console.log('========================================');
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
