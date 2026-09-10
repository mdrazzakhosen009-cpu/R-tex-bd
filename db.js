const { createClient } = require('@libsql/client');

const url = String(process.env.TURSO_DATABASE_URL || '').trim();
const authToken = String(process.env.TURSO_AUTH_TOKEN || '').trim();
if (!url || !authToken) throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required.');

const db = createClient({ url, authToken });

async function exec(sql, args = []) { return db.execute({ sql, args }); }
async function verifyConnection() { await db.execute('SELECT 1 AS ok'); }
async function transaction(fn) {
  const tx = await db.transaction('write');
  try { const result = await fn(tx); await tx.commit(); return result; }
  catch (err) { try { await tx.rollback(); } catch {} throw err; }
}

async function initDb() {
  const schema = [
    `CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS admin_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE NOT NULL, admin_id INTEGER NOT NULL, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(admin_id) REFERENCES admins(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS social_links (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, label TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', icon_url TEXT DEFAULT '', enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, description TEXT DEFAULT '', image_url TEXT DEFAULT '', active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, description TEXT DEFAULT '', price REAL NOT NULL DEFAULT 0, sale_price REAL, stock INTEGER NOT NULL DEFAULT 0, sku TEXT DEFAULT '', image_url TEXT DEFAULT '', gallery_json TEXT DEFAULT '[]', variants_json TEXT DEFAULT '[]', featured INTEGER DEFAULT 0, active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET NULL)`,
    `CREATE TABLE IF NOT EXISTS services (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '', image_url TEXT DEFAULT '', icon TEXT DEFAULT '', price REAL, button_text TEXT DEFAULT '', button_action TEXT DEFAULT '', enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS landing_sections (id INTEGER PRIMARY KEY AUTOINCREMENT, section_key TEXT UNIQUE NOT NULL, type TEXT NOT NULL, title TEXT DEFAULT '', subtitle TEXT DEFAULT '', body TEXT DEFAULT '', image_url TEXT DEFAULT '', button_text TEXT DEFAULT '', button_url TEXT DEFAULT '', content_json TEXT DEFAULT '{}', enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS faqs (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, answer TEXT NOT NULL, enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS testimonials (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT DEFAULT '', quote TEXT NOT NULL, avatar_url TEXT DEFAULT '', enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT NOT NULL, rating INTEGER NOT NULL DEFAULT 5, quote TEXT NOT NULL, image_url TEXT DEFAULT '', enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS media (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, mime_type TEXT NOT NULL, data BLOB NOT NULL, size INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, email TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_code TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL, subtotal REAL NOT NULL, delivery_fee REAL NOT NULL, total REAL NOT NULL, payment_method TEXT NOT NULL, payment_sender TEXT DEFAULT '', transaction_id TEXT DEFAULT '', payment_status TEXT DEFAULT 'pending', order_status TEXT DEFAULT 'pending', notes TEXT DEFAULT '', internal_note TEXT DEFAULT '', items_json TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(customer_id) REFERENCES customers(id))`,
    `CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, product_id INTEGER, product_name TEXT NOT NULL, sku TEXT DEFAULT '', variant TEXT DEFAULT '', unit_price REAL NOT NULL, quantity INTEGER NOT NULL, line_total REAL NOT NULL, FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', interest TEXT DEFAULT '', message TEXT DEFAULT '', status TEXT DEFAULT 'new', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS idx_products_active ON products(active)`,
    `CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(order_status)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)`,
    `CREATE INDEX IF NOT EXISTS idx_reviews_enabled ON reviews(enabled)`
  ];
  await db.batch(schema.map(sql => ({ sql, args: [] })), 'write');
  const socialColumns = await db.execute('PRAGMA table_info(social_links)');
  if(!socialColumns.rows.some(c=>c.name==='icon_url')) await db.execute("ALTER TABLE social_links ADD COLUMN icon_url TEXT DEFAULT ''");
  const orderItemColumns = await db.execute('PRAGMA table_info(order_items)');
  if(!orderItemColumns.rows.some(c=>c.name==='variant')) await db.execute("ALTER TABLE order_items ADD COLUMN variant TEXT DEFAULT ''");

  const defaults = {
    store_name:'R TEX BD', tagline:'Women’s three-piece collection · Style | Quality | Comfort', logo_url:'/assets/logo.jpg', favicon_url:'/assets/logo.jpg', currency:'৳',
    delivery_fee:'80', delivery_note:'Inside Dhaka 1–2 days · Outside Dhaka 2–5 days', phone:'', whatsapp:'', email:'', address:'', support_hours:'Every day · 10:00 AM – 10:00 PM',
    about_store:'R TEX BD brings refined women’s three-piece fashion with a focus on style, quality and comfort, with delivery across Bangladesh.', bkash_enabled:'0', bkash_number:'', nagad_enabled:'0', nagad_number:'', rocket_enabled:'0', rocket_number:'', cod_enabled:'1',
    payment_note:'For manual mobile payments, send the payment first and enter the sender number and transaction ID. Orders remain pending until verified.',
    seo_title:'R TEX BD — Women’s Three-Piece Collection', seo_description:'R TEX BD women’s three-piece collection — style, quality and comfort with delivery across Bangladesh.', seo_keywords:'R TEX BD, three piece, women fashion, Bangladesh', og_image:'/assets/logo.jpg', footer_copyright:'© Trend Wear. All rights reserved.', header_items:'[{"label":"WhatsApp","value":"01629380347","href":"https://wa.me/8801629380347","icon":"WA","enabled":true,"order":0},{"label":"Shop","href":"/shop","enabled":true,"order":1},{"label":"About","href":"/about","enabled":true,"order":2},{"label":"Contact","href":"/contact","enabled":true,"order":3}]', footer_columns:'[]', theme_config:'{"bg":"#fbf4f1","text":"#241d1b","accent":"#b85f66","button":"#2a2020","radius":"22","container_max":"1240"}'
  };
  for (const [key,value] of Object.entries(defaults)) await exec(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING`,[key,value]);
  const legacyBrand=await exec("SELECT value FROM settings WHERE key='store_name'");
  if(legacyBrand.rows[0]?.value==='Trend Wear'){
    await exec("UPDATE settings SET value=? WHERE key='store_name'",['R TEX BD']);
    await exec("UPDATE settings SET value=? WHERE key='tagline'",["Women’s three-piece collection · Style | Quality | Comfort"]);
    await exec("UPDATE settings SET value=? WHERE key='about_store'",["R TEX BD brings refined women’s three-piece fashion with a focus on style, quality and comfort, with delivery across Bangladesh."]);
    await exec("UPDATE settings SET value=? WHERE key='whatsapp'",['01629380347']);
    await exec("UPDATE settings SET value=? WHERE key='header_items'",[JSON.stringify([{label:'WhatsApp',value:'01629380347',href:'https://wa.me/8801629380347',icon:'WA',enabled:true,order:0},{label:'Shop',href:'/shop',enabled:true,order:1},{label:'About',href:'/about',enabled:true,order:2},{label:'Contact',href:'/contact',enabled:true,order:3}])]);
  }

  const catCount = await exec('SELECT COUNT(*) AS c FROM categories');
  if(Number(catCount.rows[0].c)===0){
    for(const [name,slug,desc,order] of [['Women','women','Curated womenswear',1],['Men','men','Refined menswear',2],['Accessories','accessories','Finishing pieces and accessories',3]])
      await exec('INSERT INTO categories(name,slug,description,sort_order) VALUES(?,?,?,?)',[name,slug,desc,order]);
  }

  const secCount = await exec('SELECT COUNT(*) AS c FROM landing_sections');
  if(Number(secCount.rows[0].c)===0){
    const sections=[
      ['announcement','announcement','','','New season edit now live.','', 'Discover the edit','#shop', '{}',1,0],
      ['hero','hero','Elegance in every thread.','R TEX BD · THREE-PIECE COLLECTION','Curated women’s three-piece styles with graceful silhouettes, refined details and everyday comfort.','','Shop the collection','#shop','{"secondary_text":"Quiet confidence. Strong silhouettes."}',1,1],
      ['categories','categories','Shop by edit','CURATED COLLECTIONS','Explore the collections and find your point of view.','','View all','#shop','{}',1,2],
      ['featured','products','The current edit','SELECTED PIECES','A focused selection of pieces worth wearing on repeat.','','Shop all','#shop','{"limit":8,"featured_only":true}',1,3],
      ['story','story','Made for your moments.','ABOUT R TEX BD','R TEX BD brings women’s three-piece fashion together with a soft, feminine palette, thoughtful details and dependable comfort for life across Bangladesh.','','Discover Trend Wear','#about','{}',1,4],
      ['services','services','The experience','WHY SHOP TREND WEAR','Simple, thoughtful service from discovery to delivery.','','','#','{}',1,5],
      ['benefits','benefits','The essentials, made simple.','WHY TREND WEAR','','','','','{"items":[{"eyebrow":"01","title":"Considered quality","body":"Pieces selected for repeat wear."},{"eyebrow":"02","title":"Easy ordering","body":"Clear checkout and payment steps."},{"eyebrow":"03","title":"Human support","body":"Reach us directly when you need help."}]}',1,6],
      ['faq','faq','Questions, answered.','GOOD TO KNOW','','','','','{}',1,7],
      ['reviews','reviews','Loved by our customers','CUSTOMER REVIEW STORIES','','','','','{}',1,8],
      ['contact','contact','Need a hand?','CONTACT & SUPPORT','For order help, sizing, availability or anything else, our team is here.','','Contact us','/contact','{}',1,9],
      ['footer','footer','','','Trend Wear brings together elevated everyday fashion with a clean, confident point of view.','','','','{}',1,10]
    ];
    for(const row of sections) await exec('INSERT INTO landing_sections(section_key,type,title,subtitle,body,image_url,button_text,button_url,content_json,enabled,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?)',row);
  } else {
    await exec(`UPDATE landing_sections SET type='reviews', title='Customer reviews', subtitle='WHAT CUSTOMERS ARE SAYING', sort_order=8, enabled=1 WHERE section_key='reviews'`);
    const haveReviews=await exec('SELECT id FROM landing_sections WHERE section_key=?',['reviews']);
    if(!haveReviews.rows.length) await exec('INSERT INTO landing_sections(section_key,type,title,subtitle,sort_order,enabled,content_json) VALUES(?,?,?,?,?,?,?)',['reviews','reviews','Loved by our customers','CUSTOMER REVIEW STORIES',8,1,'{}']);
  }

  const faqCount=await exec('SELECT COUNT(*) c FROM faqs');
  if(Number(faqCount.rows[0].c)===0){
    for(const [q,a,o] of [['How long does delivery take?','Inside Dhaka usually 1–2 days; outside Dhaka usually 2–5 days.',1],['Can I pay on delivery?','Yes, when Cash on Delivery is enabled by the store.',2],['Can I track my order?','Yes. Use your order code on the Track order page after checkout.',3]]) await exec('INSERT INTO faqs(question,answer,sort_order) VALUES(?,?,?)',[q,a,o]);
  }

  const pCount=await exec('SELECT COUNT(*) c FROM products');
  if(Number(pCount.rows[0].c)===0){
    const women=Number((await exec('SELECT id FROM categories WHERE slug=?',['women'])).rows[0].id);
    const men=Number((await exec('SELECT id FROM categories WHERE slug=?',['men'])).rows[0].id);
    const acc=Number((await exec('SELECT id FROM categories WHERE slug=?',['accessories'])).rows[0].id);
    const demos=[
      ['Luna Soft Blazer','luna-soft-blazer',women,4290,3890,14,'TW-W001','https://images.unsplash.com/photo-1594633312681-425c7b97ccd1?auto=format&fit=crop&w=900&q=85',1],
      ['Sculpt Knit Dress','sculpt-knit-dress',women,3490,3190,18,'TW-W002','https://images.unsplash.com/photo-1595777457583-95e059d581b8?auto=format&fit=crop&w=900&q=85',1],
      ['Quiet Tailored Shirt','quiet-tailored-shirt',men,2490,null,22,'TW-M001','https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?auto=format&fit=crop&w=900&q=85',1],
      ['Monochrome Overshirt','monochrome-overshirt',men,2990,2790,11,'TW-M002','https://images.unsplash.com/photo-1551488831-00ddcb6c6bd3?auto=format&fit=crop&w=900&q=85',1],
      ['Everyday Leather Tote','everyday-leather-tote',acc,2790,2490,9,'TW-A001','https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=900&q=85',1],
      ['Minimal Frame Sunglasses','minimal-frame-sunglasses',acc,1690,null,30,'TW-A002','https://images.unsplash.com/photo-1511499767150-a48a237f0083?auto=format&fit=crop&w=900&q=85',0],
      ['Essential Wide-Leg Trouser','essential-wide-leg-trouser',women,2890,null,16,'TW-W003','https://images.unsplash.com/photo-1506629905607-d9b1f3c1e9ba?auto=format&fit=crop&w=900&q=85',0],
      ['Relaxed Everyday Tee','relaxed-everyday-tee',men,1490,1290,35,'TW-M003','https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=900&q=85',0]
    ];
    for(const p of demos) await exec('INSERT INTO products(category_id,name,slug,price,sale_price,stock,sku,image_url,featured,active,sort_order) VALUES(?,?,?,?,?,?,?,?,?,1,?)',[p[2],p[0],p[1],p[3],p[4],p[5],p[6],p[7],p[8],p[8]?1:2]);
  }

  const reviewCount=await exec('SELECT COUNT(*) c FROM reviews');
  if(Number(reviewCount.rows[0].c)===0){
    for(const [name,rating,quote,order] of [['Sadia R.',5,'The fit was exactly as shown and the finishing felt premium.',1],['Nafis H.',5,'Clean packaging, fast delivery and a genuinely easy checkout.',2],['Mim A.',4,'Loved the fabric and the sizing guide was very helpful.',3]]) await exec('INSERT INTO reviews(customer_name,rating,quote,sort_order) VALUES(?,?,?,?)',[name,rating,quote,order]);
  }
}

module.exports={exec,transaction,initDb,verifyConnection};
