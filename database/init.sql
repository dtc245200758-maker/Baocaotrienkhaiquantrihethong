CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(180) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN','STAFF')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS menu_items (
  id SERIAL PRIMARY KEY,
  category_id INT REFERENCES categories(id) ON DELETE SET NULL,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  image_url TEXT,
  available BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS restaurant_tables (
  id SERIAL PRIMARY KEY,
  table_number INT UNIQUE NOT NULL CHECK (table_number > 0),
  capacity INT NOT NULL DEFAULT 4 CHECK (capacity > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE','OCCUPIED','RESERVED','CLEANING'))
);
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  order_code VARCHAR(32) UNIQUE NOT NULL,
  table_id INT REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','PREPARING','READY','SERVED','PAID','CANCELLED')),
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  note TEXT,
  payment_method VARCHAR(20),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INT REFERENCES menu_items(id) ON DELETE SET NULL,
  item_name VARCHAR(150) NOT NULL,
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  quantity INT NOT NULL CHECK (quantity > 0),
  note TEXT
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(80),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

INSERT INTO categories(name, description) VALUES
 ('Món chính','Các món ăn chính'), ('Đồ uống','Nước uống'), ('Tráng miệng','Món tráng miệng')
ON CONFLICT (name) DO NOTHING;
INSERT INTO menu_items(category_id,name,description,price,available)
SELECT c.id, x.name, x.description, x.price, TRUE
FROM (VALUES
 ('Cơm gà','Cơm gà thơm ngon',45000::numeric),
 ('Phở bò','Phở bò truyền thống',50000::numeric),
 ('Trà đào','Trà đào mát lạnh',25000::numeric),
 ('Bánh flan','Bánh flan caramel',18000::numeric)
) AS x(name,description,price)
JOIN categories c ON c.name = CASE WHEN x.name IN ('Trà đào') THEN 'Đồ uống'
                                  WHEN x.name = 'Bánh flan' THEN 'Tráng miệng'
                                  ELSE 'Món chính' END
WHERE NOT EXISTS (SELECT 1 FROM menu_items m WHERE m.name=x.name);
INSERT INTO restaurant_tables(table_number,capacity,status)
SELECT n, CASE WHEN n % 3 = 0 THEN 6 ELSE 4 END, 'AVAILABLE'
FROM generate_series(1,12) n
ON CONFLICT (table_number) DO NOTHING;
