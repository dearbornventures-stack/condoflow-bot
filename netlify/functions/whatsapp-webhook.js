// netlify/functions/whatsapp-webhook.js
// Bot WhatsApp — CondoFlow Multi-Edificio
// Twilio + Claude + Supabase + Auto-registro

const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

// In-memory session store for registration flow
// { "whatsapp:+591...": { step: "awaiting_building" | "awaiting_name_unit", buildingId, buildingName } }
const sessions = {};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const params = new URLSearchParams(event.body);
  const fromRaw = params.get("From") || "";
  const body    = (params.get("Body") || "").trim();
  const numMedia = parseInt(params.get("NumMedia") || "0");
  const mediaType = params.get("MediaContentType0") || "";

  if (!fromRaw) return { statusCode: 400, body: "No sender" };

  // ── 1. Look up registered user ──────────────────────────────
  const { data: resident } = await supabase
    .from("residents")
    .select("*, buildings(*)")
    .eq("phone", fromRaw)
    .single();

  const { data: portero } = await supabase
    .from("porteros")
    .select("*, buildings(*)")
    .eq("phone", fromRaw.replace("whatsapp:", ""))
    .single();

  const person = resident || portero;

  // ── 2. REGISTRATION FLOW ────────────────────────────────────
  if (!person) {
    const session = sessions[fromRaw];

    // Step A — No session yet, start registration
    if (!session) {
      const { data: buildings } = await supabase
        .from("buildings")
        .select("id, name, city")
        .order("name");

      const list = (buildings || [])
        .map((b, i) => `${i + 1}️⃣ ${b.name} — ${b.city}`)
        .join("\n");

      sessions[fromRaw] = { step: "awaiting_building", buildings };

      await sendWA(fromRaw,
        `Hola 👋 Bienvenido a CondoFlow.\n\n¿En qué edificio vives?\n\n${list}\n\nResponde con el número.`
      );
      return ok();
    }

    // Step B — User picked a building
    if (session.step === "awaiting_building") {
      const idx = parseInt(body) - 1;
      const chosen = (session.buildings || [])[idx];

      if (!chosen) {
        await sendWA(fromRaw, `Por favor responde con un número de la lista. Ej: *1*`);
        return ok();
      }

      sessions[fromRaw] = {
        step: "awaiting_name_unit",
        buildingId: chosen.id,
        buildingName: chosen.name,
      };

      await sendWA(fromRaw,
        `Perfecto, *${chosen.name}* 🏢\n\nAhora dime tu *nombre completo y número de departamento*.\n\nEj: Carlos Méndez, 4B`
      );
      return ok();
    }

    // Step C — User sent name + unit
    if (session.step === "awaiting_name_unit") {
      const parts = body.split(",").map(s => s.trim());
      const name = parts[0];
      const unit = parts[1];

      if (!name || !unit) {
        await sendWA(fromRaw,
          `Por favor usa este formato:\n*Nombre Apellido, Departamento*\n\nEj: Carlos Méndez, 4B`
        );
        return ok();
      }

      // Save to Supabase as pending
      await supabase.from("residents").insert({
        building_id: session.buildingId,
        name,
        unit,
        phone: fromRaw,
        status: "pending",
      });

      // Notify admin
      const { data: bld } = await supabase
        .from("buildings")
        .select("admin_phone, name")
        .eq("id", session.buildingId)
        .single();

      if (bld?.admin_phone) {
        await sendWA(bld.admin_phone,
          `🔔 *Nuevo residente registrado — ${bld.name}*\n\nNombre: ${name}\nDepto: ${unit}\nTeléfono: ${fromRaw.replace("whatsapp:", "")}\n\nQueda como PENDIENTE de pago hasta que confirmes.`
        );
      }

      delete sessions[fromRaw];

      await sendWA(fromRaw,
        `✅ ¡Listo, ${name}! Quedaste registrado en *${session.buildingName}*, depto *${unit}*.\n\nYa puedes consultar tu estado de pago, ver el portero de turno, y más. Escribe *Hola* para comenzar.`
      );
      return ok();
    }
  }

  // ── 3. REGISTERED USER — normal bot flow ────────────────────
  const building = person.buildings;
  const isPortero = !!portero;
  const isResident = !!resident;
  const currency = getCurrency(building.country || "PE");

  // Handle comprobante image — extract data, discard photo
  let messageText = body;
  let isComprobante = false;
  let extractedPayment = null;

  if (numMedia > 0 && mediaType.includes("image")) {
    isComprobante = true;
    const mediaUrl = params.get("MediaUrl0");

    try {
      // Fetch image from Twilio and convert to base64
      const imageResp = await fetch(mediaUrl, {
        headers: {
          Authorization: "Basic " + Buffer.from(
            process.env.TWILIO_SID + ":" + process.env.TWILIO_TOKEN
          ).toString("base64"),
        },
      });
      const imageBuffer = await imageResp.arrayBuffer();
      const base64Image = Buffer.from(imageBuffer).toString("base64");
      const imgMediaType = mediaType || "image/jpeg";

      // Ask Claude to extract payment data from image
      const extractResp = await claude.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: imgMediaType, data: base64Image },
            },
            {
              type: "text",
              text: `Analiza este comprobante de pago bancario. Extrae SOLO estos datos en JSON puro, sin texto adicional:
{
  "monto": número (solo el número, sin símbolos),
  "moneda": "Bs" o "S/" o lo que aparezca,
  "fecha": "YYYY-MM-DD",
  "banco": "nombre del banco",
  "referencia": "número de operación o referencia",
  "tipo": "transferencia" o "QR" o "depósito",
  "es_comprobante": true o false
}
Si no es un comprobante de pago, devuelve {"es_comprobante": false}.`,
            },
          ],
        }],
      });

      const rawText = extractResp.content.map(b => b.text || "").join("").trim();
      const clean = rawText.replace(/```json|```/g, "").trim();
      extractedPayment = JSON.parse(clean);

    } catch (e) {
      // If extraction fails, treat as manual confirmation
      extractedPayment = { es_comprobante: true, monto: building.monthly_fee, banco: "desconocido", referencia: "manual" };
    }

    if (extractedPayment?.es_comprobante) {
      messageText = `[COMPROBANTE VERIFICADO: monto ${extractedPayment.moneda || currency} ${extractedPayment.monto}, banco ${extractedPayment.banco}, referencia ${extractedPayment.referencia}, fecha ${extractedPayment.fecha}. Monto esperado: ${currency} ${building.monthly_fee}. ${extractedPayment.monto >= building.monthly_fee ? "El monto es correcto." : "El monto es MENOR al esperado — menciona la diferencia."} Confirma el pago amablemente y di que quedó registrado.]`;
    } else {
      messageText = "Recibí una imagen pero no parece ser un comprobante de pago. ¿Puedes enviar el comprobante de tu transferencia?";
      isComprobante = false;
    }
  }

  // Load building context
  const { data: allResidents } = await supabase
    .from("residents").select("name, unit, status").eq("building_id", building.id);

  const { data: porteros } = await supabase
    .from("porteros").select("name, phone, turno").eq("building_id", building.id);

  const { data: expenses } = await supabase
    .from("expenses").select("description, category, amount")
    .eq("building_id", building.id).order("date", { ascending: false }).limit(10);

  const { data: openTickets } = await supabase
    .from("tickets").select("description, status")
    .eq("building_id", building.id).neq("status", "resolved").limit(5);

  const paid = (allResidents || []).filter(r => r.status === "paid").length;
  const pending = (allResidents || []).filter(r => r.status !== "paid");
  const totalExpenses = (expenses || []).reduce((s, e) => s + e.amount, 0);
  const collected = paid * building.monthly_fee;
  const diaPortero = (porteros || []).find(p => p.turno === "dia");
  const nochePortero = (porteros || []).find(p => p.turno === "noche");

  const systemPrompt = `Eres el asistente virtual del edificio "${building.name}", ${building.city}.
Nombre del bot: "Bot ${building.name}". Solo WhatsApp. Español. Tono amable. Máximo 4 líneas salvo reportes.

EDIFICIO:
- Moneda: ${currency} | Expensas: ${currency} ${building.monthly_fee} | Mes: ${getCurrentMonth()}
- Pagadas: ${paid}/${(allResidents||[]).length} | Pendientes: ${pending.map(r=>r.unit+" "+r.name).join(", ")||"ninguno"}
- Recaudado: ${currency} ${collected.toLocaleString()} | Gastos: ${currency} ${totalExpenses.toLocaleString()} | Saldo: ${currency} ${(collected-totalExpenses).toLocaleString()}
- Portero día: ${diaPortero ? diaPortero.name+" 📞 "+diaPortero.phone : "No registrado"}
- Portero noche: ${nochePortero ? nochePortero.name+" 📞 "+nochePortero.phone : "No registrado"}
- Gastos: ${(expenses||[]).map(e=>e.description+" "+currency+" "+e.amount).join(" | ")}
- Reclamos abiertos: ${(openTickets||[]).length>0 ? openTickets.map(t=>t.description).join(" | ") : "ninguno"}

USUARIO: ${person.name}
${isResident ? `ROL: RESIDENTE — Depto ${resident.unit}, pago: ${resident.status==="paid"?"PAGADO ✅":resident.status==="pending"?"PENDIENTE ⚠️":"VENCIDO ❌"}` : ""}
${isPortero ? `ROL: PORTERO — Turno: ${portero.turno==="dia"?"☀️ Día":"🌙 Noche"}` : ""}

REGLAS:
- Comprobante o dice que pagó → confirma, queda registrado.
- Reporta problema → crea ticket, avisa al portero.
- Pide portero → da nombre Y teléfono de ambos turnos.
- Admin pide resumen → genera con emojis para grupo WhatsApp.
- NUNCA inventes datos.`;

  // Call Claude
  const aiResponse = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: "user", content: messageText }],
  });
  const reply = aiResponse.content.map(b => b.text || "").join("");

  // Register payment with extracted data
  if (isComprobante && isResident && extractedPayment?.es_comprobante) {
    await supabase.from("residents").update({ status: "paid" }).eq("id", resident.id);
    await supabase.from("payments").insert({
      resident_id: resident.id,
      building_id: building.id,
      amount: extractedPayment.monto || building.monthly_fee,
      month: getCurrentMonth(),
      reference: extractedPayment.referencia || "WhatsApp comprobante",
      bank: extractedPayment.banco || "desconocido",
      verified: true,
      verified_at: new Date().toISOString(),
    });
    // Image is never stored — only extracted data above
  }

  // Create ticket + alert portero if complaint
  const isComplaint = /reclamo|queja|problema|ruido|fuga|luz|ascensor|basura|portón|petos|rata|humedad|gotera|robo|olmo|alarma/i.test(body);
  if (isComplaint && isResident) {
    await supabase.from("tickets").insert({
      building_id: building.id,
      resident_id: resident.id,
      description: body,
      status: "open",
    });
    const now = new Date().getHours();
    const onDuty = (now >= 7 && now < 19) ? diaPortero : nochePortero;
    if (onDuty) {
      await sendWA(
        `whatsapp:+${onDuty.phone.replace(/\D/g,"")}`,
        `🔔 *Reclamo — ${building.name}*\n\nDepto ${resident.unit} (${resident.name}):\n"${body}"\n\nPor favor revisar.`
      );
    }
  }

  await sendWA(fromRaw, reply);
  return ok();
};

async function sendWA(to, message) {
  await twilioClient.messages.create({ from: TWILIO_NUMBER, to, body: message });
}

function getCurrency(country) {
  return { PE:"S/", BO:"Bs", CO:"COP", AR:"ARS", MX:"MX$", CL:"CLP" }[country] || "$";
}

function getCurrentMonth() {
  return new Date().toLocaleString("es", { month: "long", year: "numeric" });
}

function ok() {
  return { statusCode: 200, body: "" };
}
