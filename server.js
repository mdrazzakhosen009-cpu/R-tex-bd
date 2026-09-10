require('dotenv').config();
const express=require('express');
const path=require('path');
const helmet=require('helmet');
const cookieParser=require('cookie-parser');
const bcrypt=require('bcryptjs');
const multer=require('multer');
const crypto=require('crypto');
const { createClient } = require('@libsql/client');

const url=String(process.env.TURSO_DATABASE_URL||'').trim();
const authToken=String(process.env.TURSO_AUTH_TOKEN||'').trim();
if(!url||!authToken) throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required.');
const db=createClient({url,authToken});
async function exec(sql,args=[]){return db.execute({sql,args});}
async function verifyConnection(){await db.execute('SELECT 1 AS ok');}
async function transaction(fn){const tx=await db.transaction('write');try{const r=await fn(tx);await tx.commit();return r}catch(e){try{await tx.rollback()}catch{}throw e}}
function safeInt(v,fallback=0){const n=Number(v);return Number.isFinite(n)?Math.trunc(n):fallback}
function safeMoney(v,fallback=0){const n=Number(v);return Number.isFinite(n)&&n>=0?Math.round(n*100)/100:fallback}
function slugify(s){return String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||crypto.randomBytes(4).toString('hex')}
function bool(v){return v===true||v===1||v==='1'||v==='true'||v==='on'}
function parseJson(s,fallback){try{return JSON.parse(s)}catch{return fallback}}
function cleanText(v,max=5000){return String(v??'').trim().slice(0,max)}
function validHttpUrl(v){if(!v)return true;try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)}catch{return false}}
function normalizePhone(v){return String(v||'').replace(/[^0-9+]/g,'').slice(0,20)}
function orderCode(){return `TW-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`}
const COOKIE='tw_admin',SESSION_HOURS=8;
function hashToken(t){return crypto.createHash('sha256').update(t).digest('hex')}
function randomToken(){return crypto.randomBytes(32).toString('hex')}
function newCsrf(){return crypto.randomBytes(24).toString('hex')}
async function createSession(adminId){const token=randomToken(),csrf=newCsrf(),expires=new Date(Date.now()+SESSION_HOURS*3600_000).toISOString();await exec('DELETE FROM admin_sessions WHERE expires_at<=?',[new Date().toISOString()]);await exec('INSERT INTO admin_sessions(token_hash,admin_id,csrf_token,expires_at) VALUES(?,?,?,?)',[hashToken(token),adminId,csrf,expires]);return {token,csrf,expires}}
async function getSession(req){const token=req.cookies?.[COOKIE];if(!token)return null;const r=await exec('SELECT s.*,a.email FROM admin_sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=? AND s.expires_at>?',[hashToken(token),new Date().toISOString()]);return r.rows[0]||null}
async function requireAdmin(req,res,next){try{const session=await getSession(req);if(!session)return res.status(401).json({error:'Unauthorized'});req.adminSession=session;req.admin={id:Number(session.admin_id),email:session.email};next()}catch{res.status(500).json({error:'Authentication service unavailable'})}}
function csrf(req,res,next){const h=req.get('x-csrf-token');if(!h||h!==req.adminSession.csrf_token)return res.status(403).json({error:'Invalid security token'});next()}
async function destroySession(req){const token=req.cookies?.[COOKIE];if(token)await exec('DELETE FROM admin_sessions WHERE token_hash=?',[hashToken(token)])}
function setCookie(res,t){res.cookie(COOKIE,t,{httpOnly:true,secure:true,sameSite:'lax',maxAge:SESSION_HOURS*3600_000,path:'/'})}
function clearCookie(res){res.clearCookie(COOKIE,{httpOnly:true,secure:true,sameSite:'lax',path:'/'})}

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



const publicHits = new Map();
function rateLimited(key, limit, windowMs){ const now=Date.now(); const old=publicHits.get(key); if(!old || now-old.start>=windowMs){ publicHits.set(key,{start:now,count:1}); return false; } old.count++; return old.count>limit; }

async function getSettings() {
  const r = await exec('SELECT key,value FROM settings');
  return Object.fromEntries(r.rows.map(x=>[x.key,x.value]));
}

const app=express();
app.disable('x-powered-by');app.set('trust proxy',1);app.use(helmet({contentSecurityPolicy:false,referrerPolicy:{policy:'strict-origin-when-cross-origin'}}));app.use(express.json({limit:'1mb'}));app.use(express.urlencoded({extended:true,limit:'1mb'}));app.use(cookieParser());
app.use('/api',(req,res,next)=>{res.set('Cache-Control','no-store, max-age=0');next()});
app.get('/api/store', async (_req,res,next)=>{
  try {
    const [settings, sections, categories, services, faqs, testimonials, reviews, socials] = await Promise.all([
      exec('SELECT key,value FROM settings'),
      exec('SELECT * FROM landing_sections WHERE enabled=1 ORDER BY sort_order,id'),
      exec('SELECT * FROM categories WHERE active=1 ORDER BY sort_order,name'),
      exec('SELECT * FROM services WHERE enabled=1 ORDER BY sort_order,id'),
      exec('SELECT * FROM faqs WHERE enabled=1 ORDER BY sort_order,id'),
      exec('SELECT * FROM testimonials WHERE enabled=1 ORDER BY sort_order,id'),
      exec('SELECT * FROM reviews WHERE enabled=1 ORDER BY sort_order,id'),
      exec('SELECT * FROM social_links WHERE enabled=1 ORDER BY sort_order,id')
    ]);
    const outSections = sections.rows.map(s=>({...s, content:parseJson(s.content_json,{})}));
    res.json({settings:Object.fromEntries(settings.rows.map(x=>[x.key,x.value])),sections:outSections,categories:categories.rows,services:services.rows,faqs:faqs.rows,testimonials:testimonials.rows,reviews:reviews.rows,socials:socials.rows});
  } catch(e){ next(e); }
});

app.get('/api/categories', async (_req,res,next)=>{ try { const r=await exec('SELECT * FROM categories WHERE active=1 ORDER BY sort_order,name'); res.json(r.rows); } catch(e){next(e);} });

app.get('/api/products', async (req,res,next)=>{
  try {
    const where=['p.active=1']; const args=[];
    if(req.query.category){ where.push('c.slug=?'); args.push(String(req.query.category)); }
    if(req.query.search){ const q=`%${String(req.query.search).toLowerCase()}%`; where.push('(LOWER(p.name) LIKE ? OR LOWER(p.description) LIKE ? OR LOWER(p.sku) LIKE ?)'); args.push(q,q,q); }
    if(req.query.featured==='1') where.push('p.featured=1');
    if(req.query.availability==='in') where.push('p.stock>0');
    if(req.query.min_price!=='') { const n=Number(req.query.min_price); if(Number.isFinite(n)) { where.push('COALESCE(p.sale_price,p.price)>=?'); args.push(n); } }
    if(req.query.max_price!=='') { const n=Number(req.query.max_price); if(Number.isFinite(n)) { where.push('COALESCE(p.sale_price,p.price)<=?'); args.push(n); } }
    const sortMap={new:'p.created_at DESC',price_asc:'COALESCE(p.sale_price,p.price) ASC',price_desc:'COALESCE(p.sale_price,p.price) DESC',name:'LOWER(p.name) ASC',featured:'p.featured DESC,p.sort_order ASC,p.created_at DESC'};
    const order=sortMap[req.query.sort]||'p.featured DESC,p.sort_order ASC,p.created_at DESC';
    const r=await exec(`SELECT p.*,c.name category_name,c.slug category_slug FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 120`,args);
    res.json(r.rows.map(p=>({...p,gallery:parseJson(p.gallery_json,[]),variants:parseJson(p.variants_json,[])})));
  } catch(e){next(e);}
});

app.get('/api/products/:slug', async (req,res,next)=>{
  try{
    const r=await exec(`SELECT p.*,c.name category_name,c.slug category_slug FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.slug=? AND p.active=1`,[req.params.slug]);
    if(!r.rows[0]) return res.status(404).json({error:'Product not found'});
    const p=r.rows[0]; const related=await exec('SELECT * FROM products WHERE active=1 AND category_id IS ? AND id<>? ORDER BY featured DESC,sort_order ASC,created_at DESC LIMIT 4',[p.category_id,p.id]);
    res.json({...p,gallery:parseJson(p.gallery_json,[]),variants:parseJson(p.variants_json,[]),related:related.rows});
  }catch(e){next(e);}
});

app.post('/api/assistant', async (req,res,next)=>{
  try{
    if(rateLimited(`assistant:${req.ip}`,30,10*60_000)) return res.status(429).json({error:'Please wait a moment before sending more messages.'});
    const message=String(req.body?.message||'').trim().slice(0,1000);
    if(!message) return res.status(400).json({error:'Message is required.'});
    const settings=await getSettings();
    const products=(await exec('SELECT name,price,sale_price,stock,description FROM products WHERE active=1 ORDER BY featured DESC,sort_order ASC LIMIT 40')).rows;
    const faqs=(await exec('SELECT question,answer FROM faqs WHERE enabled=1 ORDER BY sort_order,id')).rows;
    const context={store:settings.store_name,tagline:settings.tagline,delivery:settings.delivery_note,whatsapp:settings.whatsapp||'01629380347',products,faqs};
    const key=String(process.env.GEMINI_API_KEY||'').trim();
    if(key){
      const prompt=`You are the friendly shopping assistant for ${context.store}. Answer only from the store context below. If the user asks for something not present, say you can connect them to WhatsApp. Be concise and helpful. Never invent stock, prices, policies or order status. Store context: ${JSON.stringify(context)}\nCustomer: ${message}`;
      const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key='+encodeURIComponent(key),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:.2,maxOutputTokens:350}})});
      if(r.ok){const d=await r.json();const text=d?.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('').trim();if(text)return res.json({reply:text,source:'ai'});}
    }
    const q=message.toLowerCase();
    if(/whatsapp|যোগাযোগ|contact|number|নম্বর/.test(q)) return res.json({reply:`WhatsApp: ${settings.whatsapp||'01629380347'}`});
    if(/delivery|ডেলিভারি|কতদিন|কখন/.test(q)) return res.json({reply:settings.delivery_note||'Delivery information is available at checkout.'});
    if(/price|দাম|মূল্য|cost/.test(q)){const hits=products.filter(p=>q.includes(String(p.name).toLowerCase())||String(p.name).toLowerCase().split(' ').some(w=>w.length>3&&q.includes(w)));if(hits.length)return res.json({reply:hits.slice(0,4).map(p=>`${p.name}: ৳${Number(p.sale_price??p.price).toLocaleString('en-BD')} — ${Number(p.stock)>0?'In stock':'Sold out'}`).join('\n')});}
    const faq=faqs.find(x=>q.includes(String(x.question).toLowerCase().slice(0,18)));
    if(faq)return res.json({reply:faq.answer});
    res.json({reply:`I can help with products, prices, availability and delivery. For personal assistance, WhatsApp us at ${settings.whatsapp||'01629380347'}.`,source:'store'});
  }catch(e){next(e);}
});

app.get('/api/orders/:code', async (req,res,next)=>{
  try{
    const r=await exec(`SELECT o.order_code,o.subtotal,o.delivery_fee,o.total,o.payment_method,o.payment_status,o.order_status,o.created_at,c.name,c.phone,c.email,c.address,c.city FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.order_code=?`,[req.params.code]);
    if(!r.rows[0]) return res.status(404).json({error:'Order not found'});
    const items=await exec('SELECT product_name,sku,variant,unit_price,quantity,line_total FROM order_items WHERE order_id=(SELECT id FROM orders WHERE order_code=?)',[req.params.code]);
    const o=r.rows[0];
    res.json({order_code:o.order_code,subtotal:o.subtotal,delivery_fee:o.delivery_fee,total:o.total,payment_method:o.payment_method,payment_status:o.payment_status,order_status:o.order_status,created_at:o.created_at,items:items.rows});
  }catch(e){next(e);}
});

app.post('/api/orders', async (req,res,next)=>{
  try{
    if(rateLimited(`order:${req.ip}`,12,10*60_000)) return res.status(429).json({error:'Too many order attempts. Please wait and try again.'});
    const {customer,items,payment_method='cod',payment_sender='',transaction_id='',notes=''}=req.body||{};
    if(!customer?.name||!customer?.phone||!customer?.address||!Array.isArray(items)||!items.length) return res.status(400).json({error:'Name, phone, address and at least one item are required.'});
    const settings=await getSettings();
    const allowed=[];
    if(settings.cod_enabled==='1') allowed.push('cod');
    if(settings.bkash_enabled==='1') allowed.push('bkash');
    if(settings.nagad_enabled==='1') allowed.push('nagad');
    if(settings.rocket_enabled==='1') allowed.push('rocket');
    if(!allowed.includes(payment_method)) return res.status(400).json({error:'This payment method is currently unavailable.'});
    if(payment_method!=='cod' && (!normalizePhone(payment_sender)||!String(transaction_id).trim())) return res.status(400).json({error:'Sender number and transaction ID are required for manual payment.'});

    const cleanItems=[]; const seen=new Set();
    for(const item of items.slice(0,50)){
      const id=safeInt(item.product_id); const qty=Math.max(1,Math.min(20,safeInt(item.quantity,0))); const variant=cleanText(item.variant,300);
      if(id<1||qty<1||seen.has(id)) continue; seen.add(id);
      const p=await exec('SELECT id,name,sku,price,sale_price,stock,active,image_url FROM products WHERE id=?',[id]);
      if(!p.rows[0]||!p.rows[0].active) return res.status(400).json({error:'A product in your cart is no longer available.'});
      if(Number(p.rows[0].stock)<qty) return res.status(400).json({error:`Not enough stock for ${p.rows[0].name}.`});
      const price=Number(p.rows[0].sale_price ?? p.rows[0].price); cleanItems.push({...p.rows[0],quantity:qty,variant,unit_price:price,line_total:price*qty});
    }
    if(!cleanItems.length) return res.status(400).json({error:'Your cart is empty.'});
    const subtotal=cleanItems.reduce((a,b)=>a+b.line_total,0); const delivery=safeMoney(settings.delivery_fee,80); const total=subtotal+delivery; const code=orderCode();
    const result=await transaction(async tx=>{
      const existing=await tx.execute('SELECT id FROM customers WHERE phone=?',[normalizePhone(customer.phone)]); let customerId;
      if(existing.rows[0]){
        customerId=Number(existing.rows[0].id);
        await tx.execute('UPDATE customers SET name=?,email=?,address=?,city=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[cleanText(customer.name,120),cleanText(customer.email,160),cleanText(customer.address,500),cleanText(customer.city,100),customerId]);
      } else {
        const c=await tx.execute('INSERT INTO customers(name,phone,email,address,city) VALUES(?,?,?,?,?)',[cleanText(customer.name,120),normalizePhone(customer.phone),cleanText(customer.email,160),cleanText(customer.address,500),cleanText(customer.city,100)]); customerId=Number(c.lastInsertRowid);
      }
      const o=await tx.execute('INSERT INTO orders(order_code,customer_id,subtotal,delivery_fee,total,payment_method,payment_sender,transaction_id,payment_status,order_status,notes,items_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[code,customerId,subtotal,delivery,total,payment_method,payment_method==='cod'?'':normalizePhone(payment_sender),payment_method==='cod'?'':cleanText(transaction_id,120),'pending','pending',cleanText(notes,1000),JSON.stringify(cleanItems)]);
      const orderId=Number(o.lastInsertRowid);
      for(const p of cleanItems){
        const updated=await tx.execute('UPDATE products SET stock=stock-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND active=1 AND stock>=?',[p.quantity,p.id,p.quantity]);
        if(Number(updated.rowsAffected)!==1) throw Object.assign(new Error('Stock changed'),{code:'STOCK'});
        await tx.execute('INSERT INTO order_items(order_id,product_id,product_name,sku,variant,unit_price,quantity,line_total) VALUES(?,?,?,?,?,?,?,?)',[orderId,p.id,p.name,p.sku||'',p.variant||'',p.unit_price,p.quantity,p.line_total]);
      }
      return {orderId};
    });
    res.status(201).json({success:true,order_code:code,total,payment_status:'pending'});
  }catch(e){ if(e.code==='STOCK') return res.status(409).json({error:'Stock changed while placing the order. Please review your cart and try again.'}); next(e); }
});

app.post('/api/leads', async (req,res,next)=>{
  try{
    if(rateLimited(`lead:${req.ip}`,20,10*60_000)) return res.status(429).json({error:'Too many messages. Please wait and try again.'});
    const b=req.body||{}; if(!String(b.message||'').trim() && !String(b.phone||'').trim() && !String(b.email||'').trim()) return res.status(400).json({error:'Please provide a message or contact detail.'});
    await exec('INSERT INTO leads(name,phone,email,interest,message) VALUES(?,?,?,?,?)',[cleanText(b.name,120),normalizePhone(b.phone),cleanText(b.email,160),cleanText(b.interest,160),cleanText(b.message,2000)]);
    res.status(201).json({success:true});
  }catch(e){next(e);}
});


const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 }, fileFilter: (_req,file,cb)=>cb(null,['image/jpeg','image/png','image/webp'].includes(file.mimetype)) });
const loginHits = new Map();
function loginAllowed(ip){ const now=Date.now(); const v=loginHits.get(ip)||{count:0,start:now}; if(now-v.start>15*60_000){loginHits.set(ip,{count:1,start:now});return true;} v.count++; loginHits.set(ip,v); return v.count<=10; }
function sanitizeImage(v){ const s=String(v||'').trim(); if(!s||s.length>1000)return ''; if(s.startsWith('/api/media/')) return /^\/api\/media\/\d+$/.test(s)?s:''; return validHttpUrl(s)?s:''; }
function sanitizeVariants(v){ if(Array.isArray(v)) return JSON.stringify(v.slice(0,30).map(x=>({name:cleanText(x.name,80),options:Array.isArray(x.options)?x.options.slice(0,30).map(o=>cleanText(o,80)).filter(Boolean):[]})).filter(x=>x.name)); return '[]'; }


app.post('/api/admin/login', async (req,res,next)=>{
  try{
    if(!loginAllowed(req.ip)) return res.status(429).json({error:'Too many login attempts. Try again later.'});
    const loginId=cleanText(req.body?.login_id||req.body?.email,160).toLowerCase(); const password=String(req.body?.password||'');
    if(loginId && loginId!=='admin' && loginId!=='admin@rtexbd.local') return res.status(401).json({error:'Invalid admin ID or password.'});
    const r=await exec('SELECT * FROM admins ORDER BY id LIMIT 1');
    if(!r.rows[0] || !(await bcrypt.compare(password,r.rows[0].password_hash))) return res.status(401).json({error:'Invalid admin ID or password.'});
    const s=await createSession(Number(r.rows[0].id)); setCookie(res,s.token); res.json({success:true});
  }catch(e){next(e);}
});
app.post('/api/admin/logout', requireAdmin, csrf, async (req,res,next)=>{try{await destroySession(req);clearCookie(res);res.json({success:true});}catch(e){next(e);}});
app.get('/api/admin/me', requireAdmin, (req,res)=>res.json({authenticated:true,email:req.admin.email,csrf:req.adminSession.csrf_token,expires_at:req.adminSession.expires_at}));

app.get('/api/admin/dashboard',requireAdmin,async(_req,res,next)=>{try{
  const [orders,pending,confirmed,cancelled,revenue,products,services,reviews,leads,recent,low]=await Promise.all([
    exec('SELECT COUNT(*) c FROM orders'),exec("SELECT COUNT(*) c FROM orders WHERE order_status='pending'"),exec("SELECT COUNT(*) c FROM orders WHERE order_status='confirmed'"),exec("SELECT COUNT(*) c FROM orders WHERE order_status='cancelled'"),exec("SELECT COALESCE(SUM(total),0) revenue FROM orders WHERE payment_status='paid' OR payment_method='cod'"),exec('SELECT COUNT(*) c FROM products WHERE active=1'),exec('SELECT COUNT(*) c FROM services WHERE enabled=1'),exec('SELECT COUNT(*) c FROM reviews WHERE enabled=1'),exec("SELECT COUNT(*) c FROM leads WHERE status='new'"),exec(`SELECT o.order_code,o.total,o.order_status,o.payment_method,o.created_at,c.name customer_name FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC LIMIT 8`),exec('SELECT id,name,stock,image_url FROM products WHERE active=1 AND stock<=5 ORDER BY stock ASC,name LIMIT 10')
  ]);
  res.json({stats:{orders:orders.rows[0].c,pending:pending.rows[0].c,confirmed:confirmed.rows[0].c,cancelled:cancelled.rows[0].c,revenue:Number(revenue.rows[0].revenue||0),products:products.rows[0].c,services:services.rows[0].c,reviews:reviews.rows[0].c,new_leads:leads.rows[0].c},recent_orders:recent.rows,low_stock:low.rows});
}catch(e){next(e);}});

app.get('/api/admin/settings',requireAdmin,async(_req,res,next)=>{try{const r=await exec('SELECT key,value FROM settings ORDER BY key');res.json(Object.fromEntries(r.rows.map(x=>[x.key,x.value])));}catch(e){next(e);}});
app.put('/api/admin/settings',requireAdmin,csrf,async(req,res,next)=>{try{for(const [k,v] of Object.entries(req.body||{})){if(!/^[a-z0-9_]{1,80}$/.test(k))continue; if(['whatsapp','phone'].includes(k)&&v&&!normalizePhone(v))continue; await exec('INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP',[k,cleanText(v,5000)]);}res.json({success:true});}catch(e){next(e);}});

app.get('/api/admin/categories',requireAdmin,async(_req,res,next)=>{try{res.json((await exec('SELECT * FROM categories ORDER BY sort_order,name')).rows);}catch(e){next(e);}});
app.post('/api/admin/categories',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};if(!b.name)return res.status(400).json({error:'Category name is required.'});const slug=slugify(b.slug||b.name);const r=await exec('INSERT INTO categories(name,slug,description,image_url,active,sort_order) VALUES(?,?,?,?,?,?)',[cleanText(b.name,100),slug,cleanText(b.description,500),sanitizeImage(b.image_url),bool(b.active)?1:0,safeInt(b.sort_order)]);res.status(201).json({id:Number(r.lastInsertRowid)});}catch(e){res.status(400).json({error:'Category could not be saved. Slug may already exist.'});}});
app.put('/api/admin/categories/:id',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};if(!b.name)return res.status(400).json({error:'Category name is required.'});await exec('UPDATE categories SET name=?,description=?,image_url=?,active=?,sort_order=? WHERE id=?',[cleanText(b.name,100),cleanText(b.description,500),sanitizeImage(b.image_url),bool(b.active)?1:0,safeInt(b.sort_order),safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});
app.delete('/api/admin/categories/:id',requireAdmin,csrf,async(req,res,next)=>{try{await exec('DELETE FROM categories WHERE id=?',[safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});

app.get('/api/admin/products',requireAdmin,async(_req,res,next)=>{try{const r=await exec(`SELECT p.*,c.name category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id ORDER BY p.sort_order,p.created_at DESC`);res.json(r.rows.map(p=>({...p,gallery:parseJson(p.gallery_json,[]),variants:parseJson(p.variants_json,[])})));}catch(e){next(e);}});
app.post('/api/admin/products',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};if(!b.name)return res.status(400).json({error:'Product name is required.'});if(!b.image_url)return res.status(400).json({error:'Primary product image is required.'});const slug=slugify(b.slug||b.name);if(!validHttpUrl(b.image_url) && !String(b.image_url||'').startsWith('/api/media/'))return res.status(400).json({error:'Invalid image URL.'});const r=await exec(`INSERT INTO products(category_id,name,slug,description,price,sale_price,stock,sku,image_url,gallery_json,variants_json,featured,active,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[safeInt(b.category_id)||null,cleanText(b.name,150),slug,cleanText(b.description,5000),safeMoney(b.price),b.sale_price===''||b.sale_price==null?null:safeMoney(b.sale_price),Math.max(0,safeInt(b.stock)),cleanText(b.sku,80),sanitizeImage(b.image_url),JSON.stringify(Array.isArray(b.gallery)?b.gallery.slice(0,20):[]),sanitizeVariants(b.variants),bool(b.featured)?1:0,bool(b.active===undefined?true:b.active)?1:0,safeInt(b.sort_order)]);res.status(201).json({id:Number(r.lastInsertRowid)});}catch(e){res.status(400).json({error:'Product could not be saved. The slug may already exist.'});}});
app.put('/api/admin/products/:id',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};if(!b.name)return res.status(400).json({error:'Product name is required.'});await exec(`UPDATE products SET category_id=?,name=?,description=?,price=?,sale_price=?,stock=?,sku=?,image_url=?,gallery_json=?,variants_json=?,featured=?,active=?,sort_order=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,[safeInt(b.category_id)||null,cleanText(b.name,150),cleanText(b.description,5000),safeMoney(b.price),b.sale_price===''||b.sale_price==null?null:safeMoney(b.sale_price),Math.max(0,safeInt(b.stock)),cleanText(b.sku,80),sanitizeImage(b.image_url),JSON.stringify(Array.isArray(b.gallery)?b.gallery.slice(0,20):[]),sanitizeVariants(b.variants),bool(b.featured)?1:0,bool(b.active)?1:0,safeInt(b.sort_order),safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});
app.delete('/api/admin/products/:id',requireAdmin,csrf,async(req,res,next)=>{try{await exec('UPDATE products SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?',[safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});
app.delete('/api/admin/products/:id/permanent',requireAdmin,csrf,async(req,res,next)=>{try{await exec('DELETE FROM products WHERE id=?',[safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});

app.get('/api/admin/services',requireAdmin,async(_req,res,next)=>{try{res.json((await exec('SELECT * FROM services ORDER BY sort_order,id')).rows);}catch(e){next(e);}});
app.post('/api/admin/services',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};if(!b.title)return res.status(400).json({error:'Service title is required.'});const r=await exec('INSERT INTO services(title,description,image_url,icon,price,button_text,button_action,enabled,sort_order) VALUES(?,?,?,?,?,?,?,?,?)',[cleanText(b.title,120),cleanText(b.description,700),sanitizeImage(b.image_url),cleanText(b.icon,30),b.price===''?null:safeMoney(b.price),cleanText(b.button_text,80),cleanText(b.button_action,300),bool(b.enabled)?1:0,safeInt(b.sort_order)]);res.status(201).json({id:Number(r.lastInsertRowid)});}catch(e){next(e);}});
app.put('/api/admin/services/:id',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};await exec('UPDATE services SET title=?,description=?,image_url=?,icon=?,price=?,button_text=?,button_action=?,enabled=?,sort_order=? WHERE id=?',[cleanText(b.title,120),cleanText(b.description,700),sanitizeImage(b.image_url),cleanText(b.icon,30),b.price===''?null:safeMoney(b.price),cleanText(b.button_text,80),cleanText(b.button_action,300),bool(b.enabled)?1:0,safeInt(b.sort_order),safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});
app.delete('/api/admin/services/:id',requireAdmin,csrf,async(req,res,next)=>{try{await exec('DELETE FROM services WHERE id=?',[safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});

app.get('/api/admin/landing',requireAdmin,async(_req,res,next)=>{try{res.json((await exec('SELECT * FROM landing_sections ORDER BY sort_order,id')).rows.map(s=>({...s,content:parseJson(s.content_json,{})})));}catch(e){next(e);}});
app.post('/api/admin/landing',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};if(!b.section_key||!b.type)return res.status(400).json({error:'Section key and type are required.'});const r=await exec('INSERT INTO landing_sections(section_key,type,title,subtitle,body,image_url,button_text,button_url,content_json,enabled,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[slugify(b.section_key),cleanText(b.type,40),cleanText(b.title,200),cleanText(b.subtitle,200),cleanText(b.body,5000),sanitizeImage(b.image_url),cleanText(b.button_text,100),cleanText(b.button_url,300),JSON.stringify(b.content||{}),bool(b.enabled)?1:0,safeInt(b.sort_order)]);res.status(201).json({id:Number(r.lastInsertRowid)});}catch(e){res.status(400).json({error:'Section could not be added. Section key must be unique.'});}});
app.put('/api/admin/landing/:id',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};await exec('UPDATE landing_sections SET title=?,subtitle=?,body=?,image_url=?,button_text=?,button_url=?,content_json=?,enabled=?,sort_order=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[cleanText(b.title,200),cleanText(b.subtitle,200),cleanText(b.body,5000),sanitizeImage(b.image_url),cleanText(b.button_text,100),cleanText(b.button_url,300),JSON.stringify(b.content||{}),bool(b.enabled)?1:0,safeInt(b.sort_order),safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});
app.delete('/api/admin/landing/:id',requireAdmin,csrf,async(req,res,next)=>{try{await exec('DELETE FROM landing_sections WHERE id=?',[safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});

app.get('/api/admin/faqs',requireAdmin,async(_req,res,next)=>{try{res.json((await exec('SELECT * FROM faqs ORDER BY sort_order,id')).rows);}catch(e){next(e);}});
app.post('/api/admin/faqs',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};if(!b.question||!b.answer)return res.status(400).json({error:'Question and answer are required.'});const r=await exec('INSERT INTO faqs(question,answer,enabled,sort_order) VALUES(?,?,?,?)',[cleanText(b.question,500),cleanText(b.answer,3000),bool(b.enabled)?1:0,safeInt(b.sort_order)]);res.status(201).json({id:Number(r.lastInsertRowid)});}catch(e){next(e);}});
app.put('/api/admin/faqs/:id',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};await exec('UPDATE faqs SET question=?,answer=?,enabled=?,sort_order=? WHERE id=?',[cleanText(b.question,500),cleanText(b.answer,3000),bool(b.enabled)?1:0,safeInt(b.sort_order),safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});
app.delete('/api/admin/faqs/:id',requireAdmin,csrf,async(req,res,next)=>{try{await exec('DELETE FROM faqs WHERE id=?',[safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});

app.get('/api/admin/reviews',requireAdmin,async(_req,res,next)=>{try{res.json((await exec('SELECT * FROM reviews ORDER BY sort_order,id')).rows);}catch(e){next(e);}});
app.post('/api/admin/reviews',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};const rating=Math.max(1,Math.min(5,safeInt(b.rating,5)));if(!b.customer_name||!b.quote)return res.status(400).json({error:'Customer name and review text are required.'});const r=await exec('INSERT INTO reviews(customer_name,rating,quote,image_url,enabled,sort_order) VALUES(?,?,?,?,?,?)',[cleanText(b.customer_name,120),rating,cleanText(b.quote,1500),sanitizeImage(b.image_url),bool(b.enabled)?1:0,safeInt(b.sort_order)]);res.status(201).json({id:Number(r.lastInsertRowid)});}catch(e){next(e);}});
app.put('/api/admin/reviews/:id',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};const rating=Math.max(1,Math.min(5,safeInt(b.rating,5)));if(!b.customer_name||!b.quote)return res.status(400).json({error:'Customer name and review text are required.'});await exec('UPDATE reviews SET customer_name=?,rating=?,quote=?,image_url=?,enabled=?,sort_order=? WHERE id=?',[cleanText(b.customer_name,120),rating,cleanText(b.quote,1500),sanitizeImage(b.image_url),bool(b.enabled)?1:0,safeInt(b.sort_order),safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});
app.delete('/api/admin/reviews/:id',requireAdmin,csrf,async(req,res,next)=>{try{await exec('DELETE FROM reviews WHERE id=?',[safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});

app.get('/api/admin/testimonials',requireAdmin,async(_req,res,next)=>{try{res.json((await exec('SELECT * FROM testimonials ORDER BY sort_order,id')).rows);}catch(e){next(e);}});
app.post('/api/admin/testimonials',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};if(!b.name||!b.quote)return res.status(400).json({error:'Name and quote are required.'});const r=await exec('INSERT INTO testimonials(name,role,quote,avatar_url,enabled,sort_order) VALUES(?,?,?,?,?,?)',[cleanText(b.name,120),cleanText(b.role,120),cleanText(b.quote,1000),sanitizeImage(b.avatar_url),bool(b.enabled)?1:0,safeInt(b.sort_order)]);res.status(201).json({id:Number(r.lastInsertRowid)});}catch(e){next(e);}});
app.put('/api/admin/testimonials/:id',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};await exec('UPDATE testimonials SET name=?,role=?,quote=?,avatar_url=?,enabled=?,sort_order=? WHERE id=?',[cleanText(b.name,120),cleanText(b.role,120),cleanText(b.quote,1000),sanitizeImage(b.avatar_url),bool(b.enabled)?1:0,safeInt(b.sort_order),safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});
app.delete('/api/admin/testimonials/:id',requireAdmin,csrf,async(req,res,next)=>{try{await exec('DELETE FROM testimonials WHERE id=?',[safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});

app.get('/api/admin/socials',requireAdmin,async(_req,res,next)=>{try{res.json((await exec('SELECT * FROM social_links ORDER BY sort_order,id')).rows);}catch(e){next(e);}});
app.post('/api/admin/socials',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};if(!b.platform||!b.url||!validHttpUrl(b.url))return res.status(400).json({error:'Platform and valid URL are required.'});const r=await exec('INSERT INTO social_links(platform,label,url,icon_url,enabled,sort_order) VALUES(?,?,?,?,?,?)',[cleanText(b.platform,50),cleanText(b.label||b.platform,80),b.url,sanitizeImage(b.icon_url),bool(b.enabled)?1:0,safeInt(b.sort_order)]);res.status(201).json({id:Number(r.lastInsertRowid)});}catch(e){next(e);}});
app.put('/api/admin/socials/:id',requireAdmin,csrf,async(req,res,next)=>{try{const b=req.body||{};if(!validHttpUrl(b.url))return res.status(400).json({error:'Valid URL required.'});await exec('UPDATE social_links SET platform=?,label=?,url=?,icon_url=?,enabled=?,sort_order=? WHERE id=?',[cleanText(b.platform,50),cleanText(b.label,80),b.url,sanitizeImage(b.icon_url),bool(b.enabled)?1:0,safeInt(b.sort_order),safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});
app.delete('/api/admin/socials/:id',requireAdmin,csrf,async(req,res,next)=>{try{await exec('DELETE FROM social_links WHERE id=?',[safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});

app.post('/api/admin/media',requireAdmin,csrf,upload.single('file'),async(req,res,next)=>{try{if(!req.file)return res.status(400).json({error:'Please choose an image.'});const r=await exec('INSERT INTO media(filename,mime_type,data,size) VALUES(?,?,?,?)',[cleanText(req.file.originalname,200),req.file.mimetype,req.file.buffer,req.file.size]);res.status(201).json({id:Number(r.lastInsertRowid),url:`/api/media/${Number(r.lastInsertRowid)}`});}catch(e){next(e);}});
app.delete('/api/admin/media/:id',requireAdmin,csrf,async(req,res,next)=>{try{await exec('DELETE FROM media WHERE id=?',[safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});

app.get('/api/admin/orders',requireAdmin,async(req,res,next)=>{try{const where=[];const args=[];if(req.query.status){where.push('o.order_status=?');args.push(req.query.status);}if(req.query.search){const q=`%${String(req.query.search).toLowerCase()}%`;where.push('(LOWER(o.order_code) LIKE ? OR LOWER(c.name) LIKE ? OR c.phone LIKE ?)');args.push(q,q,`%${String(req.query.search)}%`);}const r=await exec(`SELECT o.*,c.name customer_name,c.phone,c.email,c.address,c.city FROM orders o JOIN customers c ON c.id=o.customer_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY o.created_at DESC LIMIT 250`,args);res.json(r.rows);}catch(e){next(e);}});
app.get('/api/admin/orders/:id',requireAdmin,async(req,res,next)=>{try{const r=await exec(`SELECT o.*,c.name customer_name,c.phone,c.email,c.address,c.city FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?`,[safeInt(req.params.id)]);if(!r.rows[0])return res.status(404).json({error:'Order not found'});const items=await exec('SELECT * FROM order_items WHERE order_id=? ORDER BY id',[safeInt(req.params.id)]);res.json({...r.rows[0],items:items.rows});}catch(e){next(e);}});
app.put('/api/admin/orders/:id',requireAdmin,csrf,async(req,res,next)=>{try{const allowedOrder=['pending','confirmed','processing','shipped','delivered','cancelled'];const allowedPay=['pending','paid','failed','refunded'];const status=String(req.body?.order_status||'pending');const pay=String(req.body?.payment_status||'pending');if(!allowedOrder.includes(status)||!allowedPay.includes(pay))return res.status(400).json({error:'Invalid status.'});await exec('UPDATE orders SET order_status=?,payment_status=?,internal_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[status,pay,cleanText(req.body?.internal_note,2000),safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});

app.get('/api/admin/leads',requireAdmin,async(_req,res,next)=>{try{res.json((await exec('SELECT * FROM leads ORDER BY created_at DESC LIMIT 300')).rows);}catch(e){next(e);}});
app.put('/api/admin/leads/:id',requireAdmin,csrf,async(req,res,next)=>{try{const allowed=['new','contacted','resolved','archived'];const s=String(req.body?.status||'new');if(!allowed.includes(s))return res.status(400).json({error:'Invalid lead status.'});await exec('UPDATE leads SET status=? WHERE id=?',[s,safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});
app.delete('/api/admin/leads/:id',requireAdmin,csrf,async(req,res,next)=>{try{await exec('DELETE FROM leads WHERE id=?',[safeInt(req.params.id)]);res.json({success:true});}catch(e){next(e);}});

app.post('/api/admin/change-password',requireAdmin,csrf,async(req,res,next)=>{try{const current=String(req.body?.current_password||''),nextPw=String(req.body?.new_password||'');if(nextPw.length<12)return res.status(400).json({error:'New password must be at least 12 characters.'});const r=await exec('SELECT password_hash FROM admins WHERE id=?',[req.admin.id]);if(!r.rows[0]||!(await bcrypt.compare(current,r.rows[0].password_hash)))return res.status(401).json({error:'Current password is incorrect.'});const hash=await bcrypt.hash(nextPw,12);await transaction(async tx=>{await tx.execute('UPDATE admins SET password_hash=? WHERE id=?',[hash,req.admin.id]);await tx.execute('DELETE FROM admin_sessions WHERE admin_id=?',[req.admin.id]);});clearCookie(res);res.json({success:true});}catch(e){next(e);}});


app.get('/api/health',async(_req,res)=>{try{await exec('SELECT 1 AS ok');res.json({ok:true,service:'rtex-bd'})}catch{res.status(503).json({ok:false,service:'rtex-bd'})}});
app.get('/api/media/:id',async(req,res)=>{try{const r=await exec('SELECT mime_type,data FROM media WHERE id=?',[Number(req.params.id)]);if(!r.rows[0])return res.status(404).end();res.set('Cache-Control','public,max-age=31536000,immutable');res.type(r.rows[0].mime_type);res.send(Buffer.from(r.rows[0].data))}catch{res.status(500).end()}});
app.use((req,res,next)=>{ if(req.path.startsWith('/api/')) res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate'); next(); });
app.use(express.static(__dirname,{extensions:['html'],maxAge:0}));
app.get('/admin',(_req,res)=>res.sendFile(path.join(__dirname,'admin.html')));app.get('/admin/login',(_req,res)=>res.sendFile(path.join(__dirname,'admin.html')));
for(const p of ['/shop','/track','/about','/contact'])app.get(p,(_req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/product/:slug',(_req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/robots.txt',(req,res)=>{const base=`${req.protocol}://${req.get('host')}`;res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${base}/sitemap.xml`)});
app.get('/sitemap.xml',(req,res)=>{const base=`${req.protocol}://${req.get('host')}`;res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc></url><url><loc>${base}/shop</loc></url><url><loc>${base}/about</loc></url><url><loc>${base}/contact</loc></url></urlset>`)});
app.get('/{*splat}',(_req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.use((err,_req,res,_next)=>{console.error(err);if(res.headersSent)return;res.status(500).json({error:'Something went wrong. Please try again.'})});
async function bootstrap(){const password=String(process.env.ADMIN_PASSWORD||'');const adminLogin='admin';const adminEmail='admin@rtexbd.local';if(password.length<12)throw new Error('ADMIN_PASSWORD (minimum 12 characters) is required');await verifyConnection();console.log('Turso connection verified.');await initDb();const existing=await exec('SELECT id,password_hash FROM admins ORDER BY id LIMIT 1');if(!existing.rows[0]){const hash=await bcrypt.hash(password,12);await exec('INSERT INTO admins(email,password_hash) VALUES(?,?)',[adminEmail,hash]);console.log('Initial admin account created. Login ID: admin');}else{const adminId=Number(existing.rows[0].id);await exec('UPDATE admins SET email=? WHERE id=?',[adminEmail,adminId]);const hash=await bcrypt.hash(password,12);await exec('UPDATE admins SET password_hash=? WHERE id=?',[hash,adminId]);}await exec('DELETE FROM admin_sessions WHERE expires_at<=?',[new Date().toISOString()]);const port=Number(process.env.PORT||3000);app.listen(port,()=>console.log(`R TEX BD running on port ${port}`))}
bootstrap().catch(e=>{console.error(e);process.exit(1)});
