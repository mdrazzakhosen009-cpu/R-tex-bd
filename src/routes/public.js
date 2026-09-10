const express = require('express');
const { exec, transaction } = require('../db');
const { safeInt, safeMoney, cleanText, normalizePhone, orderCode, parseJson } = require('../lib/utils');

const router = express.Router();
const publicHits = new Map();
function rateLimited(key, limit, windowMs){ const now=Date.now(); const old=publicHits.get(key); if(!old || now-old.start>=windowMs){ publicHits.set(key,{start:now,count:1}); return false; } old.count++; return old.count>limit; }

async function getSettings() {
  const r = await exec('SELECT key,value FROM settings');
  return Object.fromEntries(r.rows.map(x=>[x.key,x.value]));
}

router.get('/store', async (_req,res,next)=>{
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

router.get('/categories', async (_req,res,next)=>{ try { const r=await exec('SELECT * FROM categories WHERE active=1 ORDER BY sort_order,name'); res.json(r.rows); } catch(e){next(e);} });

router.get('/products', async (req,res,next)=>{
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

router.get('/products/:slug', async (req,res,next)=>{
  try{
    const r=await exec(`SELECT p.*,c.name category_name,c.slug category_slug FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.slug=? AND p.active=1`,[req.params.slug]);
    if(!r.rows[0]) return res.status(404).json({error:'Product not found'});
    const p=r.rows[0]; const related=await exec('SELECT * FROM products WHERE active=1 AND category_id IS ? AND id<>? ORDER BY featured DESC,sort_order ASC,created_at DESC LIMIT 4',[p.category_id,p.id]);
    res.json({...p,gallery:parseJson(p.gallery_json,[]),variants:parseJson(p.variants_json,[]),related:related.rows});
  }catch(e){next(e);}
});

router.post('/assistant', async (req,res,next)=>{
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

router.get('/orders/:code', async (req,res,next)=>{
  try{
    const r=await exec(`SELECT o.order_code,o.subtotal,o.delivery_fee,o.total,o.payment_method,o.payment_status,o.order_status,o.created_at,c.name,c.phone,c.email,c.address,c.city FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.order_code=?`,[req.params.code]);
    if(!r.rows[0]) return res.status(404).json({error:'Order not found'});
    const items=await exec('SELECT product_name,sku,variant,unit_price,quantity,line_total FROM order_items WHERE order_id=(SELECT id FROM orders WHERE order_code=?)',[req.params.code]);
    const o=r.rows[0];
    res.json({order_code:o.order_code,subtotal:o.subtotal,delivery_fee:o.delivery_fee,total:o.total,payment_method:o.payment_method,payment_status:o.payment_status,order_status:o.order_status,created_at:o.created_at,items:items.rows});
  }catch(e){next(e);}
});

router.post('/orders', async (req,res,next)=>{
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

router.post('/leads', async (req,res,next)=>{
  try{
    if(rateLimited(`lead:${req.ip}`,20,10*60_000)) return res.status(429).json({error:'Too many messages. Please wait and try again.'});
    const b=req.body||{}; if(!String(b.message||'').trim() && !String(b.phone||'').trim() && !String(b.email||'').trim()) return res.status(400).json({error:'Please provide a message or contact detail.'});
    await exec('INSERT INTO leads(name,phone,email,interest,message) VALUES(?,?,?,?,?)',[cleanText(b.name,120),normalizePhone(b.phone),cleanText(b.email,160),cleanText(b.interest,160),cleanText(b.message,2000)]);
    res.status(201).json({success:true});
  }catch(e){next(e);}
});

module.exports=router;
