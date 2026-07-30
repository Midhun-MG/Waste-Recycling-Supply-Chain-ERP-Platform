const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb, saveDatabase } = require('../database');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'greencycle_secret_key_2024';

// Register
router.post('/register', async (req, res) => {
    try {
        const pool = getDb();
        const { name, email, password, role, phone, shop_name, address, pincode, vehicle_type, vehicle_capacity_kg, zone } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required' });
        }

        // Check if email exists
        const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const hashedPassword = bcrypt.hashSync(password, 10);
        const userRole = role || 'client';

        const result = await pool.query(
            `INSERT INTO users (name, email, password, role, phone, shop_name, address, pincode, vehicle_type, vehicle_capacity_kg, zone) 
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [name, email, hashedPassword, userRole, phone || null, shop_name || null, address || null, pincode || null, vehicle_type || null, vehicle_capacity_kg || 0, zone || null]
        );

        const userId = result.rows[0].id;

        const token = jwt.sign({ id: userId, email, role: userRole, name }, JWT_SECRET, { expiresIn: '24h' });

        res.json({
            message: 'Registration successful',
            token,
            user: { id: userId, name, email, role: userRole }
        });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const pool = getDb();
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];

        const valid = bcrypt.compareSync(password, user.password);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role, name: user.name },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                phone: user.phone,
                shop_name: user.shop_name
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

module.exports = router;
