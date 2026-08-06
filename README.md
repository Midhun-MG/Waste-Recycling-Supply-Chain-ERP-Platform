# ♻️ GreenCycle — Waste Recycling Supply Chain ERP

## What is this project?

GreenCycle is a **full-stack web application** that manages the entire lifecycle of **vegetable & fruit waste recycling** — from collecting waste at local shops to converting it into usable products and delivering them to customers.

Think of it like **an ERP system (Enterprise Resource Planning)** but built specifically for the waste recycling industry.

---

## Why did I build this?

Most waste recycling operations are managed manually — phone calls, spreadsheets, and paper records. This project automates that entire chain into one platform where every role (shop owner, driver, production worker, warehouse staff, customer) has their own dashboard and can work in real-time.

---

## How it works (Simple Flow)

```
Shop Owner → Creates waste pickup request
      ↓
Driver → Picks up waste and delivers to factory
      ↓
Production → Converts raw waste into products
      ↓
Packing → Packs finished products into boxes
      ↓
Warehouse → Stores and manages stock
      ↓
Customer → Browses products, places order
      ↓
Sales Driver → Delivers order to customer
```

---

## Tech Stack

| Layer          | Technology                          |
|----------------|-------------------------------------|
| **Frontend**   | HTML, CSS, JavaScript               |
| **Backend**    | Node.js + Express.js                |
| **Database**   | PostgreSQL                          |
| **Auth**       | JWT (JSON Web Tokens) + bcrypt      |
| **Real-Time**  | Socket.IO (WebSockets)              |
| **Email**      | Nodemailer (Gmail SMTP)             |

---

## Key Features (Interview Highlights)

### 1. Role-Based Access Control (14 Roles)
Each user type (admin, driver, shop owner, customer, etc.) gets a **separate dashboard** with role-specific permissions enforced through JWT middleware.

### 2. Real-Time Notifications (Socket.IO)
When a driver picks up waste, or a production order is completed — all relevant dashboards update **instantly** using WebSocket rooms grouped by role and zone.

### 3. Automated Production Pipeline
The system has an **auto-pipeline** that:
- Detects when raw materials exceed a threshold → triggers production automatically
- Auto-completes production orders based on estimated time
- Creates packing orders automatically (60% yield from raw input)
- Assigns the nearest free employee

### 4. Zone-Based Logistics
Drivers and deliveries are organized by **geographic zones and hubs**, enabling smart assignment based on location and vehicle capacity.

### 5. Email Invoicing
Auto-generates HTML invoices and sends them via **Nodemailer** (falls back to Ethereal test emails if Gmail isn't configured).

### 6. GPS Tracking Simulation
Driver locations are simulated and broadcast in real-time for dashboard map tracking.

---

## Project Structure (Simplified)

```
├── server.js           → App entry point, routes, Socket.IO setup
├── database.js         → PostgreSQL schema + seed data
├── middleware/auth.js   → JWT verification & role-based access
├── utils/email_invoice.js → Invoice generation & email sending
│
├── routes/             → 13 route files (one per role/feature)
│   ├── auth.js         → Login & registration
│   ├── client.js       → Shop owner pickup requests
│   ├── driver.js       → Driver operations
│   ├── production.js   → Production orders
│   ├── packing.js      → Packing workflow
│   ├── warehouse.js    → Stock management
│   ├── customer.js     → Customer orders
│   └── ...             → admin, auditor, sales, vehicle manager
│
└── public/             → Frontend dashboards (one folder per role)
```

---

## How to Run

```bash
# 1. Install dependencies
npm install

# 2. Make sure PostgreSQL is running (port 5433)

# 3. Start the server
npm start

# 4. Open in browser
# http://localhost:3000
```

The database tables and demo data are **auto-created** on first run.

---

## Demo Credentials

All demo accounts use password: `password123`

| Role               | Email                  |
|--------------------|------------------------|
| Shop Owner         | ravi@shop.com          |
| Driver             | suresh@driver.com      |
| Vehicle Manager    | vikram@manager.com     |
| Admin              | admin@greencycle.com   |
| Production Manager | prodmgr@gc.com         |
| Warehouse Manager  | warehouse@gc.com       |
| Customer           | customer1@gc.com       |

---

## What I learned from this project

- Designing **role-based architectures** with JWT and middleware
- Building **real-time features** using Socket.IO (rooms, broadcasting)
- Managing **complex relational data** across 14+ PostgreSQL tables
- Implementing **automated workflows** (timers, threshold-based triggers)
- Structuring a **large-scale Node.js application** with clean separation of routes, middleware, and utilities

---

<p align="center">
  <strong>🌿 GreenCycle</strong> — Waste to Value, Sustainably.
</p>
