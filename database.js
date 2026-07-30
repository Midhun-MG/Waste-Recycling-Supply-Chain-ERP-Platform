const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5433,
  database: process.env.DB_NAME || 'greencycle',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

async function initDatabase() {
  const client = await pool.connect();
  try {
    // Create tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('client','driver','vehicle_manager','admin','production_employee','production_manager','packing_employee','packing_manager','warehouse_driver','warehouse_manager','sales_driver','sales_team','auditor','customer')),
        phone TEXT,
        shop_name TEXT,
        address TEXT,
        pincode TEXT,
        vehicle_type TEXT,
        vehicle_capacity_kg DOUBLE PRECISION DEFAULT 0,
        zone TEXT,
        is_free INTEGER DEFAULT 1,
        lat DOUBLE PRECISION DEFAULT 11.0168,
        lng DOUBLE PRECISION DEFAULT 76.9558,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pickup_requests (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        driver_id INTEGER,
        waste_type TEXT NOT NULL,
        quantity_kg DOUBLE PRECISION NOT NULL,
        description TEXT,
        shop_name TEXT,
        shop_address TEXT,
        shop_pincode TEXT,
        pickup_lat DOUBLE PRECISION,
        pickup_lng DOUBLE PRECISION,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','assigned','in_transit','completed','delivered','cancelled')),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (client_id) REFERENCES users(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS collection_items (
        id SERIAL PRIMARY KEY,
        request_id INTEGER NOT NULL,
        item_name TEXT NOT NULL,
        quantity_kg DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (request_id) REFERENCES pickup_requests(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory (
        id SERIAL PRIMARY KEY,
        request_id INTEGER,
        item_name TEXT NOT NULL,
        quantity_kg DOUBLE PRECISION NOT NULL,
        source_driver_id INTEGER,
        source_shop_name TEXT,
        sent_by_manager_id INTEGER,
        status TEXT DEFAULT 'received' CHECK(status IN ('in_transit','received','processing','processed','dispatched','consumed')),
        received_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (request_id) REFERENCES pickup_requests(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS production_orders (
        id SERIAL PRIMARY KEY,
        item_name TEXT NOT NULL,
        total_kg DOUBLE PRECISION NOT NULL,
        predicted_product TEXT,
        predicted_use TEXT,
        recipe TEXT,
        confidence TEXT DEFAULT 'high',
        material_cost DOUBLE PRECISION DEFAULT 0,
        estimated_selling_price DOUBLE PRECISION DEFAULT 0,
        estimated_hours DOUBLE PRECISION DEFAULT 2,
        started_at TIMESTAMP,
        assigned_employee_id INTEGER,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_production','completed')),
        created_by INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (assigned_employee_id) REFERENCES users(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS packing_orders (
        id SERIAL PRIMARY KEY,
        production_order_id INTEGER NOT NULL,
        product_name TEXT NOT NULL,
        quantity_kg DOUBLE PRECISION NOT NULL,
        source_item TEXT,
        assigned_employee_id INTEGER,
        boxes_packed INTEGER DEFAULT 0,
        items_per_box INTEGER DEFAULT 100,
        total_items INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','packing','packed','dispatched')),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (production_order_id) REFERENCES production_orders(id),
        FOREIGN KEY (assigned_employee_id) REFERENCES users(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS warehouse_stocks (
        id SERIAL PRIMARY KEY,
        packing_order_id INTEGER,
        product_name TEXT NOT NULL,
        quantity_kg DOUBLE PRECISION NOT NULL,
        category TEXT DEFAULT 'general',
        batch_no TEXT,
        location TEXT DEFAULT 'Main Warehouse',
        price_per_kg DOUBLE PRECISION DEFAULT 0,
        status TEXT DEFAULT 'in_stock' CHECK(status IN ('in_stock','reserved','dispatching','sold')),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (packing_order_id) REFERENCES packing_orders(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS warehouse_deliveries (
        id SERIAL PRIMARY KEY,
        packing_order_id INTEGER,
        driver_id INTEGER,
        product_name TEXT NOT NULL,
        quantity_kg DOUBLE PRECISION NOT NULL,
        driver_lat DOUBLE PRECISION,
        driver_lng DOUBLE PRECISION,
        gps_active INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','picked_up','in_transit','delivered')),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (driver_id) REFERENCES users(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS zones (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        city TEXT DEFAULT 'Coimbatore',
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        radius_km DOUBLE PRECISION DEFAULT 5,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS zone_hubs (
        id SERIAL PRIMARY KEY,
        zone_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        address TEXT,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (zone_id) REFERENCES zones(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_orders (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER,
        customer_name TEXT NOT NULL,
        customer_phone TEXT,
        customer_address TEXT,
        customer_zone TEXT,
        customer_email TEXT,
        product_name TEXT NOT NULL,
        quantity_kg DOUBLE PRECISION NOT NULL,
        total_price DOUBLE PRECISION DEFAULT 0,
        warehouse_stock_id INTEGER,
        sales_driver_id INTEGER,
        zone_hub_id INTEGER,
        payment_method TEXT DEFAULT 'cod' CHECK(payment_method IN ('card','upi','cod','bank_transfer')),
        payment_status TEXT DEFAULT 'pending' CHECK(payment_status IN ('pending','paid','cod_pending','refunded')),
        status TEXT DEFAULT 'placed' CHECK(status IN ('placed','confirmed','packing','shipped','at_zone_hub','out_for_delivery','delivered','cancelled')),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (customer_id) REFERENCES users(id),
        FOREIGN KEY (warehouse_stock_id) REFERENCES warehouse_stocks(id),
        FOREIGN KEY (sales_driver_id) REFERENCES users(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        type TEXT DEFAULT 'info',
        request_id INTEGER,
        is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        id SERIAL PRIMARY KEY,
        setting_key TEXT UNIQUE NOT NULL,
        setting_value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sales_orders (
        id SERIAL PRIMARY KEY,
        customer_order_id INTEGER,
        customer_id INTEGER,
        customer_name TEXT NOT NULL,
        customer_phone TEXT,
        customer_address TEXT,
        product_name TEXT NOT NULL,
        quantity_kg DOUBLE PRECISION NOT NULL,
        unit_price DOUBLE PRECISION DEFAULT 0,
        total_price DOUBLE PRECISION DEFAULT 0,
        demand_score DOUBLE PRECISION DEFAULT 0,
        demand_notes TEXT,
        sales_person_id INTEGER,
        warehouse_notes TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','invoiced','paid','dispatched','delivered','cancelled')),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (customer_id) REFERENCES users(id),
        FOREIGN KEY (sales_person_id) REFERENCES users(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        invoice_no TEXT UNIQUE NOT NULL,
        sales_order_id INTEGER NOT NULL,
        customer_name TEXT NOT NULL,
        customer_address TEXT,
        product_name TEXT NOT NULL,
        quantity_kg DOUBLE PRECISION NOT NULL,
        unit_price DOUBLE PRECISION DEFAULT 0,
        subtotal DOUBLE PRECISION DEFAULT 0,
        tax_percent DOUBLE PRECISION DEFAULT 18,
        tax_amount DOUBLE PRECISION DEFAULT 0,
        total_amount DOUBLE PRECISION DEFAULT 0,
        payment_status TEXT DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','paid','refunded')),
        payment_method TEXT,
        payment_date TIMESTAMP,
        auditor_id INTEGER,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id),
        FOREIGN KEY (auditor_id) REFERENCES users(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_feedback (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER,
        customer_name TEXT NOT NULL,
        customer_email TEXT,
        subject TEXT NOT NULL,
        message TEXT NOT NULL,
        rating INTEGER DEFAULT 5,
        status TEXT DEFAULT 'unread' CHECK(status IN ('unread','read','resolved')),
        admin_reply TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (customer_id) REFERENCES users(id)
      )
    `);

    // Seed demo data if empty
    const count = await client.query("SELECT COUNT(*) as c FROM users");
    if (parseInt(count.rows[0].c) === 0) {
      await seedAllData(client);
    }
  } finally {
    client.release();
  }

  return pool;
}

async function seedAllData(client) {
  const hash = bcrypt.hashSync('password123', 10);

  // ===== ORIGINAL ROLES =====
  const shops = [
    ['Ravi Kumar', 'ravi@shop.com', hash, 'client', '9876543001', 'Ravi Fresh Fruits', 'RS Puram, Coimbatore', '641002'],
    ['Lakshmi Devi', 'lakshmi@shop.com', hash, 'client', '9876543002', 'Lakshmi Vegetables', 'Gandhipuram, Coimbatore', '641012'],
    ['Murugan S', 'murugan@shop.com', hash, 'client', '9876543003', 'Murugan Organic Store', 'Peelamedu, Coimbatore', '641004'],
    ['Anitha R', 'anitha@shop.com', hash, 'client', '9876543004', 'Anitha Supermarket', 'Saravanampatti, Coimbatore', '641035'],
    ['Karthik V', 'karthik@shop.com', hash, 'client', '9876543005', 'Karthik Daily Needs', 'Singanallur, Coimbatore', '641005'],
    ['Priya M', 'priya@shop.com', hash, 'client', '9876543006', 'Priya Green Grocer', 'Race Course, Coimbatore', '641018'],
    ['Senthil N', 'senthil@shop.com', hash, 'client', '9876543007', 'Senthil Market', 'Ukkadam, Coimbatore', '641001'],
    ['Divya K', 'divya@shop.com', hash, 'client', '9876543008', 'Divya Organics', 'Vadavalli, Coimbatore', '641041'],
    ['Balaji T', 'balaji@shop.com', hash, 'client', '9876543009', 'Balaji Fresh Mart', 'Kuniyamuthur, Coimbatore', '641008'],
    ['Meena P', 'meena@shop.com', hash, 'client', '9876543010', 'Meena Vegetables', 'Sulur, Coimbatore', '641402'],
    ['Harish G', 'harish@shop.com', hash, 'client', '9876543011', 'Harish Grocery', 'Gandhipuram, Coimbatore', '641012'],
    ['Nandhini S', 'nandhini@shop.com', hash, 'client', '9876543012', 'Nandhini Fresh Foods', 'RS Puram, Coimbatore', '641002'],
    ['Vijay R', 'vijay@shop.com', hash, 'client', '9876543013', 'Vijay Super Mart', 'Peelamedu, Coimbatore', '641004'],
    ['Saranya K', 'saranya@shop.com', hash, 'client', '9876543014', 'Saranya Organics', 'Singanallur, Coimbatore', '641005'],
    ['Gopal M', 'gopal@shop.com', hash, 'client', '9876543015', 'Gopal Fruit Center', 'Race Course, Coimbatore', '641018'],
    ['Kavitha L', 'kavitha@shop.com', hash, 'client', '9876543016', 'Kavitha Veg Shop', 'Saravanampatti, Coimbatore', '641035'],
    ['Mohan S', 'mohan@shop.com', hash, 'client', '9876543017', 'Mohan Fresh Market', 'Ukkadam, Coimbatore', '641001'],
    ['Revathi D', 'revathi@shop.com', hash, 'client', '9876543018', 'Revathi Natural Store', 'Vadavalli, Coimbatore', '641041'],
    ['Arun K', 'arunk@shop.com', hash, 'client', '9876543019', 'Arun Agro Foods', 'Kuniyamuthur, Coimbatore', '641008'],
    ['Sangeetha P', 'sangeetha@shop.com', hash, 'client', '9876543020', 'Sangeetha Green', 'Sulur, Coimbatore', '641402'],
    ['Prabhu M', 'prabhu@shop.com', hash, 'client', '9876543021', 'Prabhu Daily Fresh', 'RS Puram, Coimbatore', '641002'],
    ['Indra K', 'indra@shop.com', hash, 'client', '9876543022', 'Indra Wholesale', 'Gandhipuram, Coimbatore', '641012'],
    ['Rajesh V', 'rajesh@shop.com', hash, 'client', '9876543023', 'Rajesh Fruits Palace', 'Peelamedu, Coimbatore', '641004'],
    ['Sumathi R', 'sumathi@shop.com', hash, 'client', '9876543024', 'Sumathi Veg Mart', 'Singanallur, Coimbatore', '641005'],
    ['Manikandan T', 'mani@shop.com', hash, 'client', '9876543025', 'Mani Super Fresh', 'Saravanampatti, Coimbatore', '641035']
  ];
  for (const s of shops) {
    await client.query("INSERT INTO users (name, email, password, role, phone, shop_name, address, pincode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", s);
  }

  // 35 Drivers
  const drivers = [
    ['Suresh Auto', 'suresh@driver.com', hash, 'driver', '9876544001', null, 'Coimbatore', '641001', 'auto', 50, 'RS Puram'],
    ['Arjun Auto', 'arjun@driver.com', hash, 'driver', '9876544002', null, 'Coimbatore', '641018', 'auto', 50, 'Race Course'],
    ['Dhinesh Auto', 'dhinesh@driver.com', hash, 'driver', '9876544003', null, 'Coimbatore', '641012', 'auto', 50, 'Gandhipuram'],
    ['Karthik Auto', 'karthik_d@driver.com', hash, 'driver', '9876544004', null, 'Coimbatore', '641004', 'auto', 50, 'Peelamedu'],
    ['Pandi Auto', 'pandi@driver.com', hash, 'driver', '9876544005', null, 'Coimbatore', '641035', 'auto', 50, 'Saravanampatti'],
    ['Selva Auto', 'selva@driver.com', hash, 'driver', '9876544006', null, 'Coimbatore', '641005', 'auto', 50, 'Singanallur'],
    ['Gokul Auto', 'gokul@driver.com', hash, 'driver', '9876544007', null, 'Coimbatore', '641001', 'auto', 50, 'Ukkadam'],
    ['Hari Auto', 'hari@driver.com', hash, 'driver', '9876544008', null, 'Coimbatore', '641041', 'auto', 50, 'Vadavalli'],
    ['Bala Auto', 'bala@driver.com', hash, 'driver', '9876544009', null, 'Coimbatore', '641008', 'auto', 50, 'Kuniyamuthur'],
    ['Satheesh Auto', 'satheesh@driver.com', hash, 'driver', '9876544010', null, 'Coimbatore', '641402', 'auto', 50, 'Sulur'],
    ['Mani Auto', 'mani_a@driver.com', hash, 'driver', '9876544011', null, 'Coimbatore', '641002', 'auto', 50, 'RS Puram'],
    ['Vignesh Auto', 'vignesh@driver.com', hash, 'driver', '9876544012', null, 'Coimbatore', '641012', 'auto', 50, 'Gandhipuram'],
    ['Rajan LoadAuto', 'rajan@driver.com', hash, 'driver', '9876544013', null, 'Coimbatore', '641012', 'load_auto', 200, 'Gandhipuram'],
    ['Manoj LoadAuto', 'manoj@driver.com', hash, 'driver', '9876544014', null, 'Coimbatore', '641004', 'load_auto', 200, 'Peelamedu'],
    ['Kumar LoadAuto', 'kumar_d@driver.com', hash, 'driver', '9876544015', null, 'Coimbatore', '641002', 'load_auto', 200, 'RS Puram'],
    ['Siva LoadAuto', 'siva_d@driver.com', hash, 'driver', '9876544016', null, 'Coimbatore', '641005', 'load_auto', 200, 'Singanallur'],
    ['Shankar LoadAuto', 'shankar@driver.com', hash, 'driver', '9876544017', null, 'Coimbatore', '641035', 'load_auto', 200, 'Saravanampatti'],
    ['Prakash LoadAuto', 'prakash_d@driver.com', hash, 'driver', '9876544018', null, 'Coimbatore', '641018', 'load_auto', 200, 'Race Course'],
    ['Ramu LoadAuto', 'ramu@driver.com', hash, 'driver', '9876544019', null, 'Coimbatore', '641001', 'load_auto', 200, 'Ukkadam'],
    ['Naren LoadAuto', 'naren@driver.com', hash, 'driver', '9876544020', null, 'Coimbatore', '641041', 'load_auto', 200, 'Vadavalli'],
    ['Pradeep LoadAuto', 'pradeep@driver.com', hash, 'driver', '9876544021', null, 'Coimbatore', '641008', 'load_auto', 200, 'Kuniyamuthur'],
    ['Anbu LoadAuto', 'anbu@driver.com', hash, 'driver', '9876544022', null, 'Coimbatore', '641402', 'load_auto', 200, 'Sulur'],
    ['Surya LoadAuto', 'surya@driver.com', hash, 'driver', '9876544023', null, 'Coimbatore', '641012', 'load_auto', 200, 'Gandhipuram'],
    ['Raghu LoadAuto', 'raghu@driver.com', hash, 'driver', '9876544024', null, 'Coimbatore', '641004', 'load_auto', 200, 'Peelamedu'],
    ['Velu Truck', 'velu@driver.com', hash, 'driver', '9876544025', null, 'Coimbatore', '641005', 'truck', 1000, 'Singanallur'],
    ['Kannan Truck', 'kannan_d@driver.com', hash, 'driver', '9876544026', null, 'Coimbatore', '641012', 'truck', 1000, 'Gandhipuram'],
    ['Muruges Truck', 'muruges@driver.com', hash, 'driver', '9876544027', null, 'Coimbatore', '641004', 'truck', 1000, 'Peelamedu'],
    ['Raja Truck', 'raja@driver.com', hash, 'driver', '9876544028', null, 'Coimbatore', '641002', 'truck', 1000, 'RS Puram'],
    ['Jagan Truck', 'jagan@driver.com', hash, 'driver', '9876544029', null, 'Coimbatore', '641035', 'truck', 1000, 'Saravanampatti'],
    ['Thiru Truck', 'thiru@driver.com', hash, 'driver', '9876544030', null, 'Coimbatore', '641018', 'truck', 1000, 'Race Course'],
    ['Dharma Truck', 'dharma@driver.com', hash, 'driver', '9876544031', null, 'Coimbatore', '641001', 'truck', 1000, 'Ukkadam'],
    ['Vijayan Truck', 'vijayan@driver.com', hash, 'driver', '9876544032', null, 'Coimbatore', '641041', 'truck', 1000, 'Vadavalli'],
    ['Mohan Truck', 'mohan_d@driver.com', hash, 'driver', '9876544033', null, 'Coimbatore', '641008', 'truck', 1000, 'Kuniyamuthur'],
    ['Subash Truck', 'subash@driver.com', hash, 'driver', '9876544034', null, 'Coimbatore', '641402', 'truck', 1000, 'Sulur'],
    ['Pandian Truck', 'pandian@driver.com', hash, 'driver', '9876544035', null, 'Coimbatore', '641005', 'truck', 1000, 'Singanallur']
  ];
  for (const d of drivers) {
    await client.query("INSERT INTO users (name, email, password, role, phone, shop_name, address, pincode, vehicle_type, vehicle_capacity_kg, zone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", d);
  }

  await client.query("INSERT INTO users (name, email, password, role, phone, address) VALUES ($1,$2,$3,$4,$5,$6)",
    ['Vikram Manager', 'vikram@manager.com', hash, 'vehicle_manager', '9876545001', 'Coimbatore']);
  await client.query("INSERT INTO users (name, email, password, role, phone, address) VALUES ($1,$2,$3,$4,$5,$6)",
    ['Admin Owner', 'admin@greencycle.com', hash, 'admin', '9876545002', 'Coimbatore']);

  // Production employees
  const prodEmps = [
    ['Raj Production', 'prod1@gc.com', hash, 'production_employee', '9876546001', 'Coimbatore'],
    ['Anand Production', 'prod2@gc.com', hash, 'production_employee', '9876546002', 'Coimbatore'],
    ['Kumar Production', 'prod3@gc.com', hash, 'production_employee', '9876546003', 'Coimbatore'],
    ['Siva Production', 'prod4@gc.com', hash, 'production_employee', '9876546004', 'Coimbatore']
  ];
  for (const e of prodEmps) {
    await client.query("INSERT INTO users (name, email, password, role, phone, address, is_free) VALUES ($1,$2,$3,$4,$5,$6,1)", e);
  }

  // Packing employees (35)
  const packNames = [
    'Devi', 'Gowri', 'Selvi', 'Mala', 'Rani', 'Vani', 'Bhavani', 'Kavitha', 'Suganya', 'Rekha',
    'Priya', 'Latha', 'Saroja', 'Pushpa', 'Jaya', 'Thenmozhi', 'Malathi', 'Vasuki', 'Shanthi', 'Geetha',
    'Padma', 'Sumathi', 'Amudha', 'Chitra', 'Eswari', 'Fathima', 'Hemalatha', 'Indhu', 'Janani', 'Kalai',
    'Lakshmi', 'Mangai', 'Nithya', 'Oviya', 'Parvathi'
  ];
  for (let i = 0; i < packNames.length; i++) {
    const idx = i + 1;
    await client.query("INSERT INTO users (name, email, password, role, phone, address, is_free) VALUES ($1,$2,$3,$4,$5,$6,1)",
      [`${packNames[i]} Packing`, `pack${idx}@gc.com`, hash, 'packing_employee', `987654700${idx.toString().padStart(2, '0')}`, 'Coimbatore']);
  }

  // Production Manager
  await client.query("INSERT INTO users (name, email, password, role, phone, address) VALUES ($1,$2,$3,$4,$5,$6)",
    ['Senthil Prod Manager', 'prodmgr@gc.com', hash, 'production_manager', '9876546010', 'Coimbatore']);
  // Packing Manager
  await client.query("INSERT INTO users (name, email, password, role, phone, address) VALUES ($1,$2,$3,$4,$5,$6)",
    ['Lakshmi Pack Manager', 'packmgr@gc.com', hash, 'packing_manager', '9876546011', 'Coimbatore']);

  // Warehouse drivers
  const whDrivers = [
    ['Kannan WH Driver', 'whdriver1@gc.com', hash, 'warehouse_driver', '9876548001', 'Coimbatore', 'truck', 2000],
    ['Muthu WH Driver', 'whdriver2@gc.com', hash, 'warehouse_driver', '9876548002', 'Coimbatore', 'truck', 2000],
    ['Sathish WH Driver', 'whdriver3@gc.com', hash, 'warehouse_driver', '9876548003', 'Coimbatore', 'truck', 1500]
  ];
  for (const d of whDrivers) {
    await client.query("INSERT INTO users (name, email, password, role, phone, address, vehicle_type, vehicle_capacity_kg, is_free) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1)", d);
  }

  // Warehouse manager
  await client.query("INSERT INTO users (name, email, password, role, phone, address) VALUES ($1,$2,$3,$4,$5,$6)",
    ['Prakash WH Manager', 'warehouse@gc.com', hash, 'warehouse_manager', '9876549001', 'Coimbatore']);

  // Sales drivers
  const salesDrivers = [
    ['Ramesh Sales', 'sales1@gc.com', hash, 'sales_driver', '9876550001', 'Coimbatore', 'bike', 50, 'RS Puram'],
    ['Ganesh Sales', 'sales2@gc.com', hash, 'sales_driver', '9876550002', 'Coimbatore', 'bike', 50, 'RS Puram'],
    ['Vivek Sales', 'sales3@gc.com', hash, 'sales_driver', '9876550003', 'Coimbatore', 'auto', 100, 'Gandhipuram'],
    ['Dinesh Sales', 'sales4@gc.com', hash, 'sales_driver', '9876550004', 'Coimbatore', 'bike', 50, 'Peelamedu'],
    ['Naveen Sales', 'sales5@gc.com', hash, 'sales_driver', '9876550005', 'Coimbatore', 'auto', 100, 'Singanallur'],
    ['Karthik Sales', 'sales6@gc.com', hash, 'sales_driver', '9876550006', 'Coimbatore', 'bike', 50, 'Saravanampatti']
  ];
  for (const d of salesDrivers) {
    await client.query("INSERT INTO users (name, email, password, role, phone, address, vehicle_type, vehicle_capacity_kg, zone, is_free) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)", d);
  }

  // Customers
  const customers = [
    ['Arun Customer', 'customer1@gc.com', hash, 'customer', '9876560001', '12 Cross Street, RS Puram, Coimbatore', '641002', 'RS Puram'],
    ['Bharathi Customer', 'customer2@gc.com', hash, 'customer', '9876560002', '45 Main Road, Gandhipuram, Coimbatore', '641012', 'Gandhipuram'],
    ['Chitra Customer', 'customer3@gc.com', hash, 'customer', '9876560003', '78 Lake View, Peelamedu, Coimbatore', '641004', 'Peelamedu'],
    ['Deepa Customer', 'customer4@gc.com', hash, 'customer', '9876560004', '22 Park Avenue, Singanallur, Coimbatore', '641005', 'Singanallur'],
    ['Elan Customer', 'customer5@gc.com', hash, 'customer', '9876560005', '99 IT Park, Saravanampatti, Coimbatore', '641035', 'Saravanampatti']
  ];
  for (const c of customers) {
    await client.query("INSERT INTO users (name, email, password, role, phone, address, pincode, zone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", c);
  }

  // ===== ZONES =====
  const ZONES = [
    ['RS Puram', 'Coimbatore', 11.0120, 76.9555, 4],
    ['Gandhipuram', 'Coimbatore', 11.0183, 76.9725, 3],
    ['Peelamedu', 'Coimbatore', 11.0240, 76.9920, 4],
    ['Saravanampatti', 'Coimbatore', 11.0510, 77.0240, 5],
    ['Singanallur', 'Coimbatore', 10.9985, 77.0280, 4],
    ['Race Course', 'Coimbatore', 11.0040, 76.9610, 3]
  ];
  for (const z of ZONES) {
    await client.query("INSERT INTO zones (name, city, lat, lng, radius_km) VALUES ($1,$2,$3,$4,$5)", z);
  }
  for (let i = 0; i < ZONES.length; i++) {
    await client.query("INSERT INTO zone_hubs (zone_id, name, address, lat, lng) VALUES ($1,$2,$3,$4,$5)",
      [i + 1, `${ZONES[i][0]} Hub`, `Zone Distribution Center, ${ZONES[i][0]}, Coimbatore`, ZONES[i][2], ZONES[i][3]]);
  }

  // ===== PICKUP REQUESTS =====
  const managerResult = await client.query("SELECT id FROM users WHERE role='vehicle_manager' LIMIT 1");
  const managerId = managerResult.rows[0].id;
  const wasteTypes = ['fruits', 'vegetables', 'mixed', 'organic', 'dairy'];
  const itemSet = ['Rotten Apple', 'Spoiled Orange', 'Old Banana', 'Stale Tomato', 'Old Potato', 'Wilted Spinach', 'Waste Turmeric', 'Lemon Peel', 'Ginger Waste', 'Coconut Waste', 'Sugarcane Bagasse', 'Cabbage Waste', 'Carrot Waste', 'Onion Waste', 'Mango Waste', 'Pineapple Waste', 'Chili Waste', 'Beetroot Waste', 'Papaya Waste', 'Guava Waste'];

  const zoneLocs = {
    '641002': [11.0120, 76.9555], '641012': [11.0183, 76.9725], '641004': [11.0240, 76.9920],
    '641035': [11.0510, 77.0240], '641005': [10.9985, 77.0280], '641018': [11.0040, 76.9610],
    '641001': [11.0010, 76.9600], '641041': [11.0150, 76.9300], '641008': [10.9600, 76.9560], '641402': [11.0300, 77.0700]
  };

  for (let i = 0; i < 50; i++) {
    const shopId = (i % 25) + 1;
    const driverId = (i % 35) + 26;
    const qty = Math.round((5 + Math.random() * 150) * 10) / 10;
    const status = i < 40 ? 'completed' : ['pending', 'assigned', 'in_transit', 'pending', 'assigned', 'pending', 'in_transit', 'pending', 'assigned', 'pending'][i - 40];
    const pin = shops[shopId - 1][7];
    const loc = zoneLocs[pin] || [11.0168, 76.9558];
    const pLat = loc[0] + (Math.random() - 0.5) * 0.01;
    const pLng = loc[1] + (Math.random() - 0.5) * 0.01;
    const daysAgo = 50 - i;

    await client.query(
      `INSERT INTO pickup_requests (client_id, driver_id, waste_type, quantity_kg, description, shop_name, shop_address, shop_pincode, pickup_lat, pickup_lng, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW() - INTERVAL '${daysAgo} days', NOW() - INTERVAL '${daysAgo} days')`,
      [shopId, status === 'pending' ? null : driverId, wasteTypes[i % 5], qty, `Waste collection #${i + 1}`, shops[shopId - 1][5], shops[shopId - 1][6], shops[shopId - 1][7], pLat, pLng, status]
    );
    if (status === 'completed') {
      const itemIdx = i % itemSet.length;
      await client.query("INSERT INTO collection_items (request_id, item_name, quantity_kg) VALUES ($1,$2,$3)", [i + 1, itemSet[itemIdx], qty]);
    }
  }

  // ===== INVENTORY =====
  const cleanItems = [
    ['Apple Waste', 25, 'received'], ['Orange Peel Waste', 30, 'received'],
    ['Banana Waste', 40, 'processing'], ['Tomato Waste', 20, 'processing'],
    ['Potato Waste', 35, 'received'], ['Spinach Waste', 15, 'received'],
    ['Turmeric Waste', 18, 'received'], ['Lemon Peel Waste', 22, 'received'],
    ['Sugarcane Bagasse', 28, 'processing'], ['Coconut Waste', 32, 'received']
  ];
  for (let i = 0; i < cleanItems.length; i++) {
    const driverId = (i % 35) + 26;
    const shopId = (i % 25) + 1;
    const daysAgo = 10 - i;
    await client.query(
      `INSERT INTO inventory (request_id, item_name, quantity_kg, source_driver_id, source_shop_name, status, received_at) VALUES ($1,$2,$3,$4,$5,$6, NOW() - INTERVAL '${daysAgo} days')`,
      [i + 1, cleanItems[i][0], cleanItems[i][1], driverId, shops[shopId - 1][5], cleanItems[i][2]]
    );
  }

  // ===== PRODUCTION ORDERS =====
  const prodEmpResult = await client.query("SELECT id FROM users WHERE role='production_employee'");
  const prodEmpIds = prodEmpResult.rows;
  const prodOrders = [
    ['Rotten Apple', 25, 'Organic Compost Fertilizer', 'Decomposed apple waste -> nutrient-rich compost for agriculture', '[{"item":"Rotten Apple","kg":20},{"item":"Cow Dung","kg":5},{"item":"EM Solution","kg":1},{"item":"Sawdust","kg":3}]', 45, 120, 4, 'completed', -5],
    ['Spoiled Orange', 30, 'Natural Orange Peel Dye', 'Dried orange peel waste -> natural textile dye', '[{"item":"Orange Peel Waste","kg":15},{"item":"Alum Mordant","kg":2},{"item":"Water","kg":10}]', 85, 250, 6, 'completed', -4],
    ['Old Banana', 40, 'Biogas & Methane Fuel', 'Fermented banana waste -> biogas for energy', '[{"item":"Rotten Banana","kg":30},{"item":"Water","kg":20},{"item":"Inoculum","kg":2}]', 30, 90, 8, 'in_production', -2],
    ['Stale Tomato', 20, 'Lycopene Extract', 'Waste tomato skin -> lycopene for cosmetics', '[{"item":"Tomato Waste","kg":15},{"item":"Ethanol","kg":3}]', 180, 650, 10, 'in_production', -1],
    ['Old Potato', 35, 'Bio-Starch Plastic', 'Spoiled potato -> starch for eco-packaging', '[{"item":"Waste Potato","kg":25},{"item":"Water","kg":15}]', 60, 180, 5, 'pending', 0],
    ['Wilted Spinach', 15, 'Chlorophyll Green Dye', 'Wilted spinach -> natural green dye for textiles', '[{"item":"Spinach Waste","kg":10},{"item":"Ethanol","kg":2}]', 140, 500, 3, 'pending', 0],
    ['Waste Turmeric', 18, 'Curcumin Supplement', 'Old turmeric -> curcumin extract for medicine', '[{"item":"Turmeric Waste","kg":8},{"item":"Ethanol","kg":3}]', 250, 1200, 12, 'pending', 0],
    ['Lemon Peel', 22, 'Citric Acid Cleaner', 'Waste lemon peels -> citric acid for cleaning', '[{"item":"Lemon Peel","kg":15},{"item":"Water","kg":8}]', 130, 400, 6, 'pending', 0]
  ];

  for (let i = 0; i < prodOrders.length; i++) {
    const p = prodOrders[i];
    const empId = prodEmpIds[i % prodEmpIds.length].id;
    const startedAt = p[8] !== 'pending' ? `NOW() + INTERVAL '${p[9]} days'` : 'NULL';
    await client.query(
      `INSERT INTO production_orders (item_name, total_kg, predicted_product, predicted_use, recipe, material_cost, estimated_selling_price, estimated_hours, started_at, assigned_employee_id, status, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ${startedAt}, $9,$10,$11, NOW() + INTERVAL '${p[9]} days')`,
      [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8] !== 'pending' ? empId : null, p[8], managerId]
    );
  }

  // ===== PACKING ORDERS =====
  const packEmpResult = await client.query("SELECT id FROM users WHERE role='packing_employee'");
  const packEmpIds = packEmpResult.rows;
  const getPackEmp = (idx) => packEmpIds[idx] ? packEmpIds[idx].id : null;

  await client.query(`INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item, assigned_employee_id, total_items, items_per_box, boxes_packed, status, created_at) VALUES (1, 'Apple Cider Vinegar', 30, 'Rotten Apple', $1, 300, 100, 3, 'packed', NOW() - INTERVAL '3 days')`, [getPackEmp(0)]);
  await client.query(`INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item, assigned_employee_id, total_items, items_per_box, boxes_packed, status, created_at) VALUES (1, 'Apple Cider Vinegar', 25, 'Rotten Apple', $1, 200, 100, 2, 'packed', NOW() - INTERVAL '3 days')`, [getPackEmp(1)]);
  await client.query(`INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item, assigned_employee_id, total_items, items_per_box, boxes_packed, status, created_at) VALUES (1, 'Apple Cider Vinegar', 20, 'Rotten Apple', $1, 200, 100, 2, 'packed', NOW() - INTERVAL '2 days')`, [getPackEmp(2)]);
  await client.query(`INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item, assigned_employee_id, total_items, items_per_box, boxes_packed, status, created_at) VALUES (2, 'Natural Orange Peel Dye', 18, 'Spoiled Orange', $1, 200, 100, 2, 'packed', NOW() - INTERVAL '2 days')`, [getPackEmp(3)]);
  await client.query(`INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item, assigned_employee_id, total_items, items_per_box, boxes_packed, status, created_at) VALUES (2, 'Natural Orange Peel Dye', 15, 'Spoiled Orange', $1, 100, 100, 1, 'packed', NOW() - INTERVAL '2 days')`, [getPackEmp(4)]);
  await client.query(`INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item, assigned_employee_id, total_items, items_per_box, boxes_packed, status, created_at) VALUES (1, 'Organic Compost Fertilizer', 40, 'Rotten Apple', $1, 400, 100, 4, 'packed', NOW() - INTERVAL '4 days')`, [getPackEmp(5)]);
  await client.query(`INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item, assigned_employee_id, total_items, items_per_box, boxes_packed, status, created_at) VALUES (1, 'Organic Compost Fertilizer', 35, 'Old Potato', $1, 300, 100, 3, 'packed', NOW() - INTERVAL '3 days')`, [getPackEmp(6)]);
  await client.query(`INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item, assigned_employee_id, total_items, items_per_box, boxes_packed, status, created_at) VALUES (1, 'Organic Compost Fertilizer', 25, 'Wilted Spinach', $1, 200, 100, 2, 'packed', NOW() - INTERVAL '3 days')`, [getPackEmp(7)]);
  await client.query(`INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item, assigned_employee_id, total_items, items_per_box, boxes_packed, status, created_at) VALUES (3, 'Biogas Fuel Pack', 50, 'Old Banana', $1, 500, 100, 2, 'packing', NOW() - INTERVAL '1 days')`, [getPackEmp(8)]);
  await client.query(`INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item, assigned_employee_id, total_items, items_per_box, boxes_packed, status, created_at) VALUES (4, 'Turmeric Face Pack', 30, 'Waste Turmeric', $1, 300, 100, 1, 'packing', NOW() - INTERVAL '1 days')`, [getPackEmp(9)]);
  await client.query(`INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item, assigned_employee_id, total_items, items_per_box, boxes_packed, status, created_at) VALUES (5, 'Biogas Fuel Pack', 40, 'Old Banana', NULL, 400, 100, 0, 'pending', NOW())`);
  await client.query(`INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item, assigned_employee_id, total_items, items_per_box, boxes_packed, status, created_at) VALUES (6, 'Turmeric Face Pack', 25, 'Waste Turmeric', NULL, 250, 100, 0, 'pending', NOW())`);
  await client.query(`INSERT INTO packing_orders (production_order_id, product_name, quantity_kg, source_item, assigned_employee_id, total_items, items_per_box, boxes_packed, status, created_at) VALUES (7, 'Chlorophyll Green Dye', 20, 'Wilted Spinach', NULL, 200, 100, 0, 'pending', NOW())`);

  // ===== WAREHOUSE STOCKS =====
  await client.query(`INSERT INTO warehouse_stocks (packing_order_id, product_name, quantity_kg, category, batch_no, location, price_per_kg, status) VALUES (1, 'Apple Cider Vinegar', 75, 'Food Product', 'BATCH-001', 'Cold Storage', 180, 'in_stock')`);
  await client.query(`INSERT INTO warehouse_stocks (product_name, quantity_kg, category, batch_no, location, price_per_kg, status) VALUES ('Natural Orange Peel Dye', 33, 'Dye', 'BATCH-002', 'Main Warehouse - B', 250, 'in_stock')`);
  await client.query(`INSERT INTO warehouse_stocks (product_name, quantity_kg, category, batch_no, location, price_per_kg, status) VALUES ('Organic Compost Fertilizer', 100, 'Fertilizer', 'BATCH-003', 'Main Warehouse - A', 120, 'in_stock')`);
  await client.query(`INSERT INTO warehouse_stocks (product_name, quantity_kg, category, batch_no, location, price_per_kg, status) VALUES ('Biogas Fuel Pack', 20, 'Energy', 'BATCH-004', 'Main Warehouse - C', 90, 'in_stock')`);
  await client.query(`INSERT INTO warehouse_stocks (product_name, quantity_kg, category, batch_no, location, price_per_kg, status) VALUES ('Turmeric Face Pack', 5, 'Cosmetics', 'BATCH-005', 'Main Warehouse - A', 600, 'in_stock')`);

  // ===== WAREHOUSE DELIVERIES =====
  const whDriverResult = await client.query("SELECT id FROM users WHERE role='warehouse_driver'");
  if (whDriverResult.rows.length > 0) {
    const whd1 = whDriverResult.rows[0].id;
    const whd2 = whDriverResult.rows[1] ? whDriverResult.rows[1].id : whd1;
    const whd3 = whDriverResult.rows[2] ? whDriverResult.rows[2].id : whd1;

    await client.query(`INSERT INTO warehouse_deliveries (packing_order_id, driver_id, product_name, quantity_kg, status, created_at) VALUES (8, $1, 'Beta-Carotene Powder', 42.3, 'pending', NOW() - INTERVAL '1 hours')`, [whd1]);
    await client.query(`INSERT INTO warehouse_deliveries (packing_order_id, driver_id, product_name, quantity_kg, status, created_at) VALUES (9, $1, 'Curcumin Supplement', 35.0, 'pending', NOW() - INTERVAL '30 minutes')`, [whd2]);
    await client.query(`INSERT INTO warehouse_deliveries (packing_order_id, driver_id, product_name, quantity_kg, status, created_at) VALUES (10, $1, 'Citric Acid Cleaner', 28.5, 'pending', NOW())`, [whd3]);
    await client.query(`INSERT INTO warehouse_deliveries (packing_order_id, driver_id, product_name, quantity_kg, status, created_at, updated_at) VALUES (5, $1, 'Guava Leaf Herbal Tea Extract', 49.3, 'delivered', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')`, [whd1]);
    await client.query(`INSERT INTO warehouse_deliveries (packing_order_id, driver_id, product_name, quantity_kg, status, created_at, updated_at) VALUES (6, $1, 'Biogas & Methane Fuel', 38.0, 'delivered', NOW() - INTERVAL '1 days', NOW() - INTERVAL '1 days')`, [whd2]);
    await client.query(`INSERT INTO warehouse_deliveries (packing_order_id, driver_id, product_name, quantity_kg, status, gps_active, driver_lat, driver_lng, created_at) VALUES (7, $1, 'Chlorophyll Green Dye', 22.0, 'in_transit', 1, 11.015, 76.958, NOW() - INTERVAL '20 minutes')`, [whd3]);
  }

  // ===== CUSTOMER ORDERS =====
  const custResult = await client.query("SELECT id FROM users WHERE role='customer'");
  const custIds = custResult.rows;
  if (custIds.length > 0) {
    await client.query(`INSERT INTO customer_orders (customer_id, customer_name, customer_phone, customer_address, customer_zone, product_name, quantity_kg, total_price, warehouse_stock_id, status) VALUES ($1, 'Arun Customer', '9876560001', '12 Cross Street, RS Puram', 'RS Puram', 'Organic Compost Fertilizer', 5, 600, 3, 'delivered')`, [custIds[0].id]);
    await client.query(`INSERT INTO customer_orders (customer_id, customer_name, customer_phone, customer_address, customer_zone, product_name, quantity_kg, total_price, warehouse_stock_id, status) VALUES ($1, 'Bharathi Customer', '9876560002', '45 Main Road, Gandhipuram', 'Gandhipuram', 'Natural Orange Peel Dye', 2, 500, 2, 'shipped')`, [custIds[1].id]);
    await client.query(`INSERT INTO customer_orders (customer_id, customer_name, customer_phone, customer_address, customer_zone, product_name, quantity_kg, total_price, warehouse_stock_id, status, created_at) VALUES ($1, 'Chitra Customer', '9876560003', '78 Lake View, Peelamedu', 'Peelamedu', 'Apple Cider Vinegar', 10, 1800, 1, 'placed', NOW() - INTERVAL '1 days')`, [custIds[2].id]);
    await client.query(`INSERT INTO customer_orders (customer_id, customer_name, customer_phone, customer_address, customer_zone, product_name, quantity_kg, total_price, warehouse_stock_id, status, created_at) VALUES ($1, 'Deepa Customer', '9876560004', '22 Park Avenue, Singanallur', 'Singanallur', 'Biogas Fuel Pack', 15, 1350, 4, 'placed', NOW() - INTERVAL '1 days')`, [custIds[3].id]);
    await client.query(`INSERT INTO customer_orders (customer_id, customer_name, customer_phone, customer_address, customer_zone, product_name, quantity_kg, total_price, warehouse_stock_id, status, created_at) VALUES ($1, 'Elan Customer', '9876560005', '99 IT Park, Saravanampatti', 'Saravanampatti', 'Organic Compost Fertilizer', 20, 2400, 3, 'placed', NOW())`, [custIds[4].id]);
    await client.query(`INSERT INTO customer_orders (customer_id, customer_name, customer_phone, customer_address, customer_zone, product_name, quantity_kg, total_price, warehouse_stock_id, status, created_at) VALUES ($1, 'Arun Customer', '9876560001', '12 Cross Street, RS Puram', 'RS Puram', 'Turmeric Face Pack', 3, 1800, 5, 'placed', NOW())`, [custIds[0].id]);
    await client.query(`INSERT INTO customer_orders (customer_id, customer_name, customer_phone, customer_address, customer_zone, product_name, quantity_kg, total_price, warehouse_stock_id, status, created_at) VALUES ($1, 'Bharathi Customer', '9876560002', '45 Main Road, Gandhipuram', 'Gandhipuram', 'Apple Cider Vinegar', 8, 1440, 1, 'placed', NOW())`, [custIds[1].id]);
  }

  // ===== SALES TEAM & AUDITOR =====
  await client.query("INSERT INTO users (name, email, password, role, phone, address) VALUES ($1,$2,$3,$4,$5,$6)",
    ['Karthik Sales Lead', 'sales@gc.com', hash, 'sales_team', '9876551001', 'Coimbatore']);
  await client.query("INSERT INTO users (name, email, password, role, phone, address) VALUES ($1,$2,$3,$4,$5,$6)",
    ['Meena Auditor', 'auditor@gc.com', hash, 'auditor', '9876552001', 'Coimbatore']);

  const salesUserResult = await client.query("SELECT id FROM users WHERE role='sales_team' LIMIT 1");
  const salesUserId = salesUserResult.rows[0].id;
  const auditorUserResult = await client.query("SELECT id FROM users WHERE role='auditor' LIMIT 1");
  const auditorUserId = auditorUserResult.rows[0].id;

  // ===== SALES ORDERS =====
  if (custIds.length > 0) {
    await client.query(`INSERT INTO sales_orders (customer_order_id, customer_id, customer_name, customer_phone, customer_address, product_name, quantity_kg, unit_price, total_price, demand_score, demand_notes, sales_person_id, status, created_at) VALUES (1, $1, 'Arun Customer', '9876560001', '12 Cross Street, RS Puram', 'Organic Compost Fertilizer', 5, 120, 600, 92, 'High demand in RS Puram zone. Repeat customer.', $2, 'delivered', NOW() - INTERVAL '5 days')`, [custIds[0].id, salesUserId]);
    await client.query(`INSERT INTO sales_orders (customer_order_id, customer_id, customer_name, customer_phone, customer_address, product_name, quantity_kg, unit_price, total_price, demand_score, demand_notes, sales_person_id, status, created_at) VALUES (2, $1, 'Bharathi Customer', '9876560002', '45 Main Road, Gandhipuram', 'Natural Orange Peel Dye', 2, 250, 500, 78, 'Textile industry demand growing.', $2, 'dispatched', NOW() - INTERVAL '3 days')`, [custIds[1].id, salesUserId]);
    await client.query(`INSERT INTO sales_orders (customer_order_id, customer_id, customer_name, customer_phone, customer_address, product_name, quantity_kg, unit_price, total_price, demand_score, demand_notes, sales_person_id, status, created_at) VALUES (3, $1, 'Chitra Customer', '9876560003', '78 Lake View, Peelamedu', 'Apple Cider Vinegar', 10, 180, 1800, 85, 'Health food trend. Strong forecast.', $2, 'paid', NOW() - INTERVAL '2 days')`, [custIds[2].id, salesUserId]);
    await client.query(`INSERT INTO sales_orders (customer_order_id, customer_id, customer_name, customer_phone, customer_address, product_name, quantity_kg, unit_price, total_price, demand_score, demand_notes, sales_person_id, status, created_at) VALUES (4, $1, 'Deepa Customer', '9876560004', '22 Park Avenue, Singanallur', 'Biogas Fuel Pack', 15, 90, 1350, 70, 'Energy sector demand moderate.', $2, 'approved', NOW() - INTERVAL '1 days')`, [custIds[3].id, salesUserId]);
    await client.query(`INSERT INTO sales_orders (customer_order_id, customer_id, customer_name, customer_phone, customer_address, product_name, quantity_kg, unit_price, total_price, demand_score, demand_notes, sales_person_id, status, created_at) VALUES (5, $1, 'Elan Customer', '9876560005', '99 IT Park, Saravanampatti', 'Organic Compost Fertilizer', 20, 120, 2400, 88, 'IT park landscaping demand. Bulk order.', $2, 'pending', NOW())`, [custIds[4].id, salesUserId]);
    await client.query(`INSERT INTO sales_orders (customer_order_id, customer_id, customer_name, customer_phone, customer_address, product_name, quantity_kg, unit_price, total_price, demand_score, demand_notes, sales_person_id, status, created_at) VALUES (6, $1, 'Arun Customer', '9876560001', '12 Cross Street, RS Puram', 'Turmeric Face Pack', 3, 600, 1800, 95, 'Cosmetics industry hot demand!', $2, 'pending', NOW())`, [custIds[0].id, salesUserId]);
  }

  // ===== INVOICES =====
  await client.query(`INSERT INTO invoices (invoice_no, sales_order_id, customer_name, customer_address, product_name, quantity_kg, unit_price, subtotal, tax_percent, tax_amount, total_amount, payment_status, payment_method, payment_date, auditor_id, created_at) VALUES ('INV-2026-001', 1, 'Arun Customer', '12 Cross Street, RS Puram', 'Organic Compost Fertilizer', 5, 120, 600, 18, 108, 708, 'paid', 'bank_transfer', NOW() - INTERVAL '4 days', $1, NOW() - INTERVAL '5 days')`, [auditorUserId]);
  await client.query(`INSERT INTO invoices (invoice_no, sales_order_id, customer_name, customer_address, product_name, quantity_kg, unit_price, subtotal, tax_percent, tax_amount, total_amount, payment_status, payment_method, payment_date, auditor_id, created_at) VALUES ('INV-2026-002', 2, 'Bharathi Customer', '45 Main Road, Gandhipuram', 'Natural Orange Peel Dye', 2, 250, 500, 18, 90, 590, 'paid', 'upi', NOW() - INTERVAL '2 days', $1, NOW() - INTERVAL '3 days')`, [auditorUserId]);
  await client.query(`INSERT INTO invoices (invoice_no, sales_order_id, customer_name, customer_address, product_name, quantity_kg, unit_price, subtotal, tax_percent, tax_amount, total_amount, payment_status, payment_method, payment_date, auditor_id, created_at) VALUES ('INV-2026-003', 3, 'Chitra Customer', '78 Lake View, Peelamedu', 'Apple Cider Vinegar', 10, 180, 1800, 18, 324, 2124, 'paid', 'card', NOW() - INTERVAL '1 days', $1, NOW() - INTERVAL '2 days')`, [auditorUserId]);

  // ===== ADMIN SETTINGS =====
  await client.query(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('base_investment', '50000')`);
  await client.query(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('currency', 'INR')`);

  console.log('=== DEMO ACCOUNTS SEEDED ===');
  console.log('  Sales: sales@gc.com | Auditor: auditor@gc.com / password123');
}

// No-op for backward compatibility (PG auto-persists)
function saveDatabase() { }

function getDb() {
  return pool;
}

module.exports = { initDatabase, getDb, saveDatabase };
