// netlify/functions/whatsapp-webhook.js
// Bot WhatsApp — CondoFlow Multi-Edificio
// Twilio + Claude + Supabase

const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // "whatsapp:+14155238886"

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  // 1. Parse incoming WhatsApp message from Twilio
  const params = new URLSearchParams(event.body);
  const fromRaw = params.get("From");       // "whatsapp:+51987654321"
  const body    = params.get("Body") || ""; // message text
  const numMedia = parseInt(params.get("NumMedia") || "0");
  const mediaType = params.get("MediaContentType0") || "";

  if (!fromRaw) return { statusCode: 400, body: "No sender" };

  // 2. Look up resident/portero by phone number in Supabase
  const phone = fromRaw; // keep "whatsapp:+XXXXXX" format

  const { data: resident } = await supabase
    .from("residents")
    .select("*, buildings(*)")
    .eq("phone", phone)
    .single();

  const { data: portero } = await supabase
    .from("porteros")
    .select("*, buildings(*)")
    .eq("phone", phone.replace("whatsapp:", ""))
    .single();

  const person = resident || portero;

  // 3. Unknown number — ask to register
  if (!person) {
    await sendWA(fromRaw, `Hola 👋 No encontré tu número registrado en ningún edificio CondoFlow.\n\nContacta a tu administrador para que te agregue al sistema.`);
    return { statusCode: 200, body: "" };
  }

  const building = person.buildings;
  const isPortero = !!portero;
  const isResident = !!resident;
  const currency = getCurrency(building.country || "PE");

  // 4. Handle image/document (comprobante de pago)
  let messageText = body;
  let isComprobante = false;

  if (numMedia > 0 && mediaType.includes("image")) {
    isComprobante = true;
    messageText = `[El residente envió una imagen que parece ser un comprobante de pago. 
Trata este mensaje como si hubiera enviado su comprobante de transferencia o QR pagado.
Monto esperado: ${currency} ${building.monthly_fee}. 
Confirma el pago, registra en el sistema y responde amablemente.]`;
  }

  // 5. Build building context for Claude
  const { data: allResidents } = await supabase
    .from("residents")
    .select("name, unit, status")
    .eq("building_id", building.id);

  const { data: porteros } = await supabase
    .from("porteros")
    .select("name, phone, turno")
    .eq("building_id", building.id);

  const { data: expenses } = await supabase
    .from("expenses")
    .select("description, category, amount")
    .eq("building_id", building.id)
    .order("date", { ascending: false })
    .limit(10);

  const { data: openTickets } = await supabase
    .from("tickets")
    .select("description, status, created_at")
    .eq("building_id", building.id)
    .neq("status", "resolved")
    .limit(5);

  const paid = (allResidents || []).filter(r => r.status === "paid").length;
  const pending = (allResidents || []).filter(r => r.status !== "paid");
  const totalExpenses = (expenses || []).reduce((s, e) => s + e.amount, 0);
  const collected = paid * building.monthly_fee;

  const diaPortero = (porteros || []).find(p => p.turno === "dia");
  const nochePortero = (porteros || []).find(p => p.turno === "noche");

  const systemPrompt = `Eres el asistente virtual del edificio "${building.name}" ubicado en ${building.city}.
Tu nombre es "Bot ${building.name}". Solo respondes por WhatsApp. Siempre en español. Tono amable y profesional. Usa emojis con moderación. Máximo 4 líneas por respuesta salvo reportes.

DATOS DEL EDIFICIO:
- Moneda: ${currency}
- Expensas mensuales: ${currency} ${building.monthly_fee}
- Mes actual: ${getCurrentMonth()}
- Unidades pagadas: ${paid}/${(allResidents || []).length}
- Pendientes/vencidos: ${pending.map(r => r.unit + " " + r.name).join(", ") || "ninguno"}
- Total recaudado: ${currency} ${collected.toLocaleString()}
- Total gastos: ${currency} ${totalExpenses.toLocaleString()}
- Saldo: ${currency} ${(collected - totalExpenses).toLocaleString()}
- Portero día: ${diaPortero ? diaPortero.name + " 📞 " + diaPortero.phone : "No registrado"}
- Portero noche: ${nochePortero ? nochePortero.name + " 📞 " + nochePortero.phone : "No registrado"}
- Gastos recientes: ${(expenses || []).map(e => e.description + " " + currency + " " + e.amount).join(" | ")}
- Reclamos abiertos: ${(openTickets || []).length > 0 ? openTickets.map(t => t.description).join(" | ") : "ninguno"}

USUARIO: ${person.name}
${isResident ? `ROL: RESIDENTE — Unidad ${resident.unit}, pago: ${resident.status === "paid" ? "PAGADO ✅" : resident.status === "pending" ? "PENDIENTE ⚠️" : "VENCIDO ❌"}` : ""}
${isPortero ? `ROL: PORTERO/VIGILANTE — Turno: ${portero.turno === "dia" ? "☀️ Día" : "🌙 Noche"}` : ""}

INSTRUCCIONES:
- Si el residente manda un comprobante o dice que pagó → confirma amablemente, dile que quedó registrado.
- Si alguien reporta un problema (ruido, fuga, luz, etc.) → crea un ticket y avisa al portero de turno.
- Si el portero reporta una novedad → confirma registro y notifica al admin.
- Si piden el portero → da nombre Y teléfono de ambos turnos.
- Si el admin pide resumen → genera uno con emojis listo para el grupo de WhatsApp.
- NUNCA inventes datos. Solo usa los datos arriba.`;

  // 6. Call Claude
  const aiResponse = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: "user", content: messageText }],
  });

  const reply = aiResponse.content.map(b => b.text || "").join("");

  // 7. If comprobante → update payment status in Supabase
  if (isComprobante && isResident) {
    await supabase
      .from("residents")
      .update({ status: "paid" })
      .eq("id", resident.id);

    await supabase.from("payments").insert({
      resident_id: resident.id,
      building_id: building.id,
      amount: building.monthly_fee,
      month: getCurrentMonth(),
      reference: "WhatsApp comprobante",
      verified: true,
      verified_at: new Date().toISOString(),
    });
  }

  // 8. If complaint/ticket detected → save ticket + alert portero
  const isComplaint = /reclamo|queja|problema|ruido|fuga|luz|ascensor|basura|portón|petos|rata|humedad|gotera/i.test(body);
  if (isComplaint && isResident && diaPortero) {
    await supabase.from("tickets").insert({
      building_id: building.id,
      resident_id: resident.id,
      description: body,
      status: "open",
    });

    // Alert portero on duty
    const now = new Date().getHours();
    const porteroOnDuty = now >= 7 && now < 19 ? diaPortero : nochePortero;
    if (porteroOnDuty) {
      await sendWA(
        `whatsapp:+${porteroOnDuty.phone.replace(/\D/g, "")}`,
        `🔔 *Reclamo nuevo — ${building.name}*\n\nDepto ${resident.unit} (${resident.name}):\n"${body}"\n\nPor favor revisar y responder.`
      );
    }
  }

  // 9. Send reply back to resident/portero
  await sendWA(fromRaw, reply);

  return { statusCode: 200, body: "" };
};

async function sendWA(to, message) {
  await twilioClient.messages.create({
    from: TWILIO_NUMBER,
    to: to,
    body: message,
  });
}

function getCurrency(country) {
  const map = { PE: "S/", BO: "Bs", CO: "COP", AR: "ARS", MX: "MX$", CL: "CLP" };
  return map[country] || "$";
}

function getCurrentMonth() {
  return new Date().toLocaleString("es", { month: "long", year: "numeric" });
}
