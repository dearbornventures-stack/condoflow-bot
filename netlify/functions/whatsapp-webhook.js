// netlify/functions/whatsapp-webhook.js
// CondoFlow v2 — WhatsApp AI Building Manager
// Twilio + Claude Vision + Supabase + Sessions

const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");

// ── Clients ──────────────────────────────────────────────
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const ADMIN_PHONES = (process.env.ADMIN_PHONES || "").split(",").map(p => p.trim()).filter(Boolean);
// Set ADMIN_PHONES in Netlify env as: whatsapp:+59174638308

// ── Main Handler ─────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    // ── 1. Validate Twilio signature ──
    const sig = event.headers["x-twilio-signature"];
    const url = process.env.WEBHOOK_URL || `https://${event.headers.host}${event.path}`;
    const params = Object.fromEntries(new URLSearchParams(event.body));

    if (sig && process.env.TWILIO_TOKEN) {
      const valid = twilio.validateRequest(
        process.env.TWILIO_TOKEN, sig, url, params
      );
      if (!valid) {
        console.warn("⚠️ Invalid Twilio signature — rejecting");
        return { statusCode: 403, body: "Forbidden" };
      }
    }

    // ── 2. Parse incoming message ──
    const fromRaw   = params.From || "";          // "whatsapp:+59174638308"
    const body      = (params.Body || "").trim();
    const numMedia  = parseInt(params.NumMedia || "0");
    const mediaUrl  = params.MediaUrl0 || "";
    const mediaType = params.MediaContentType0 || "";

    if (!fromRaw) return { statusCode: 400, body: "No sender" };

    const phoneClean = fromRaw.replace("whatsapp:", "");
    const isAdmin = ADMIN_PHONES.includes(fromRaw);

    // ── 3. Look up person in Supabase ──
    const { data: resident, error: resErr } = await supabase
      .from("residents")
      .select("*, buildings(*)")
      .eq("phone", fromRaw)
      .maybeSingle();

    const { data: portero, error: portErr } = await supabase
      .from("porteros")
      .select("*, buildings(*)")
      .eq("phone", phoneClean)
      .maybeSingle();

    const person = resident || portero;

    // ── 4. Unknown number ──
    if (!person) {
      await sendWA(fromRaw,
        `Hola 👋 No encontré tu número registrado en ningún edificio CondoFlow.\n\n` +
        `Contacta a tu administrador para que te agregue al sistema.`
      );
      // Notify admins about unknown number attempt
      for (const admin of ADMIN_PHONES) {
        await sendWA(admin,
          `📋 Número no registrado intentó usar el bot:\n${fromRaw}\nMensaje: "${body.substring(0, 100)}"`
        );
      }
      return ok();
    }

    const building   = person.buildings;
    const isPortero  = !!portero && !resident;
    const isResident = !!resident;
    const currency   = getCurrency(building.country || "BO");

    // ── 5. Load session (conversation memory) ──
    const sessionKey = `${fromRaw}:${building.id}`;
    let history = await loadSession(sessionKey);

    // ── 6. Handle image → Claude Vision reads it ──
    let userContent = [];
    let imageAnalysis = null;

    if (numMedia > 0 && mediaUrl && mediaType.startsWith("image")) {
      try {
        // Fetch image from Twilio (requires auth)
        const imgResponse = await fetch(mediaUrl, {
          headers: {
            Authorization: "Basic " + Buffer.from(
              `${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`
            ).toString("base64"),
          },
        });
        const imgBuffer = await imgResponse.arrayBuffer();
        const base64 = Buffer.from(imgBuffer).toString("base64");
        const mType = mediaType.includes("png") ? "image/png" : "image/jpeg";

        // Ask Claude Vision to read the comprobante
        const visionResult = await claude.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 500,
          messages: [{
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mType, data: base64 },
              },
              {
                type: "text",
                text: `Analiza esta imagen. Si es un comprobante de pago/transferencia bancaria, extrae:
- monto (número exacto)
- banco (nombre del banco)
- referencia o número de operación
- fecha de la transacción

Responde SOLO en JSON así:
{"es_comprobante": true, "monto": 1150, "banco": "BNB", "referencia": "12345", "fecha": "2026-03-15"}

Si NO es un comprobante de pago, responde:
{"es_comprobante": false, "descripcion": "breve descripción de qué es la imagen"}

Solo JSON, sin markdown.`,
              },
            ],
          }],
        });

        const visionText = visionResult.content.map(b => b.text || "").join("");
        try {
          imageAnalysis = JSON.parse(visionText.replace(/```json|```/g, "").trim());
        } catch {
          imageAnalysis = { es_comprobante: false, descripcion: "No pude leer la imagen" };
        }
      } catch (imgErr) {
        console.error("Error reading image:", imgErr.message);
        imageAnalysis = { es_comprobante: false, descripcion: "Error al procesar imagen" };
      }

      // Build the message for the main Claude call
      if (imageAnalysis?.es_comprobante) {
        userContent.push({
          type: "text",
          text: body
            ? `${body}\n\n[COMPROBANTE DETECTADO: ${JSON.stringify(imageAnalysis)}]`
            : `[COMPROBANTE DE PAGO DETECTADO: ${JSON.stringify(imageAnalysis)}]`,
        });
      } else {
        userContent.push({
          type: "text",
          text: body
            ? `${body}\n\n[Imagen enviada: ${imageAnalysis?.descripcion || "imagen no reconocida"}]`
            : `[Envió una imagen: ${imageAnalysis?.descripcion || "imagen no reconocida"}]`,
        });
      }
    } else if (body) {
      userContent.push({ type: "text", text: body });
    } else {
      // Voice note, sticker, or empty — acknowledge
      await sendWA(fromRaw, "Recibí tu mensaje pero solo puedo procesar texto y fotos por ahora 📝📷");
      return ok();
    }

    // ── 7. Build building context ──
    const [
      { data: allResidents },
      { data: porteros },
      { data: expenses },
      { data: openTickets },
      { data: payments },
    ] = await Promise.all([
      supabase.from("residents").select("id, name, unit, status, phone").eq("building_id", building.id),
      supabase.from("porteros").select("name, phone, turno").eq("building_id", building.id),
      supabase.from("expenses").select("description, category, amount").eq("building_id", building.id).order("date", { ascending: false }).limit(10),
      supabase.from("tickets").select("description, status, created_at, unit").eq("building_id", building.id).neq("status", "resolved").limit(5),
      isResident
        ? supabase.from("payments").select("month, amount, verified").eq("resident_id", resident.id).order("created_at", { ascending: false }).limit(6)
        : Promise.resolve({ data: [] }),
    ]);

    const resList = allResidents || [];
    const paid = resList.filter(r => r.status === "paid").length;
    const pending = resList.filter(r => r.status !== "paid");
    const totalExpenses = (expenses || []).reduce((s, e) => s + e.amount, 0);
    const collected = paid * building.monthly_fee;

    const diaPortero = (porteros || []).find(p => p.turno === "dia");
    const nochePortero = (porteros || []).find(p => p.turno === "noche");

    // Check if resident already paid this month (duplicate protection)
    const currentMonth = getCurrentMonth();
    const alreadyPaidThisMonth = (payments || []).some(
      p => p.month === currentMonth && p.verified
    );

    // ── 8. System prompt with roles ──
    const systemPrompt = buildSystemPrompt({
      building, currency, currentMonth, resList, paid, pending,
      collected, totalExpenses, expenses, openTickets,
      diaPortero, nochePortero,
      person, isResident, isPortero, isAdmin,
      resident, portero, payments, alreadyPaidThisMonth,
      imageAnalysis,
    });

    // ── 9. Call Claude with conversation history ──
    const messages = [
      ...history,
      { role: "user", content: userContent },
    ];

    const aiResponse = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    });

    const reply = aiResponse.content.map(b => b.text || "").join("");

    // ── 10. Save to session memory ──
    history.push({ role: "user", content: body || "[imagen]" });
    history.push({ role: "assistant", content: reply });
    // Keep last 10 exchanges (20 messages)
    if (history.length > 20) history = history.slice(-20);
    await saveSession(sessionKey, history);

    // ── 11. Process comprobante → save payment ──
    if (imageAnalysis?.es_comprobante && isResident) {
      if (alreadyPaidThisMonth) {
        // Don't double-register — Claude already knows and will tell them
        console.log(`Duplicate payment attempt: ${resident.name} (${currentMonth})`);
      } else {
        // Find the oldest unpaid month
        const unpaidMonth = await findOldestUnpaidMonth(resident.id, building.id, currentMonth);

        await supabase.from("payments").insert({
          resident_id: resident.id,
          building_id: building.id,
          amount: imageAnalysis.monto || building.monthly_fee,
          month: unpaidMonth,
          bank: imageAnalysis.banco || "No detectado",
          reference: imageAnalysis.referencia || "Sin referencia",
          payment_date: imageAnalysis.fecha || new Date().toISOString().split("T")[0],
          verified: false,  // Admin must verify
          source: "whatsapp_comprobante",
        });

        // Update resident status for that month
        // (only mark "pending" verification, not "paid" — admin confirms)
        await supabase
          .from("residents")
          .update({ status: "pending" })
          .eq("id", resident.id);

        // Notify admin
        for (const admin of ADMIN_PHONES) {
          await sendWA(admin,
            `💰 *Comprobante recibido*\n\n` +
            `${resident.name} (${resident.unit})\n` +
            `Monto: ${currency} ${imageAnalysis.monto || "?"}\n` +
            `Banco: ${imageAnalysis.banco || "?"}\n` +
            `Ref: ${imageAnalysis.referencia || "?"}\n` +
            `Mes: ${unpaidMonth}\n\n` +
            `⚠️ Pendiente de verificación`
          );
        }
      }
    }

    // ── 12. Let Claude decide if it's a complaint ──
    // Instead of regex, check Claude's response for ticket indicators
    if (isResident && body && !imageAnalysis?.es_comprobante) {
      const isComplaint = await detectComplaint(body, reply);
      if (isComplaint) {
        // Check for duplicate recent ticket (same resident, last 24h)
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: recentTickets } = await supabase
          .from("tickets")
          .select("id")
          .eq("resident_id", resident.id)
          .eq("building_id", building.id)
          .gte("created_at", oneDayAgo);

        if (!recentTickets || recentTickets.length === 0) {
          await supabase.from("tickets").insert({
            building_id: building.id,
            resident_id: resident.id,
            unit: resident.unit,
            description: body.substring(0, 500),
            status: "open",
          });

          // Alert portero on duty
          const porteroOnDuty = getPorteroOnDuty(diaPortero, nochePortero);
          if (porteroOnDuty) {
            await sendWA(
              `whatsapp:${porteroOnDuty.phone.startsWith("+") ? "" : "+"}${porteroOnDuty.phone.replace(/\D/g, "")}`,
              `🔔 *Reclamo — ${building.name}*\n\n` +
              `${resident.unit} (${resident.name}):\n"${body.substring(0, 200)}"\n\n` +
              `Por favor revisar.`
            );
          }

          // Alert admin
          for (const admin of ADMIN_PHONES) {
            if (admin !== fromRaw) {
              await sendWA(admin,
                `📋 *Nuevo reclamo — ${building.name}*\n${resident.unit}: ${body.substring(0, 200)}`
              );
            }
          }
        }
      }
    }

    // ── 13. Send reply ──
    // Split long messages (WhatsApp limit ~1600 chars)
    const chunks = splitMessage(reply, 1500);
    for (const chunk of chunks) {
      await sendWA(fromRaw, chunk);
    }

    return ok();

  } catch (err) {
    console.error("❌ CondoFlow error:", err);
    // Don't crash — send a friendly error message
    try {
      const fromRaw = new URLSearchParams(event.body).get("From");
      if (fromRaw) {
        await sendWA(fromRaw, "Disculpa, tuve un problema técnico. Intenta de nuevo en unos segundos 🔧");
      }
    } catch { /* can't even send error message, just log */ }
    return ok(); // Always return 200 to prevent Twilio retries
  }
};


// ══════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════

function ok() {
  return { statusCode: 200, body: "" };
}

// ── WhatsApp send ──
async function sendWA(to, message) {
  try {
    await twilioClient.messages.create({
      from: TWILIO_NUMBER,
      to,
      body: message,
    });
  } catch (err) {
    console.error(`Failed to send WA to ${to}:`, err.message);
  }
}

// ── Split long messages ──
function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Find last newline before limit
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.3) cut = maxLen; // no good newline, hard cut
    chunks.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut).trimStart();
  }
  return chunks;
}

// ── Session memory ──
async function loadSession(key) {
  try {
    const { data } = await supabase
      .from("sessions")
      .select("messages")
      .eq("session_key", key)
      .maybeSingle();
    if (data?.messages) {
      return typeof data.messages === "string"
        ? JSON.parse(data.messages)
        : data.messages;
    }
  } catch (err) {
    console.error("Session load error:", err.message);
  }
  return [];
}

async function saveSession(key, messages) {
  try {
    await supabase.from("sessions").upsert(
      {
        session_key: key,
        messages: JSON.stringify(messages),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "session_key" }
    );
  } catch (err) {
    console.error("Session save error:", err.message);
  }
}

// ── Complaint detection via Claude ──
async function detectComplaint(userMessage, botReply) {
  // Quick regex pre-filter to avoid extra API call on normal messages
  const maybeComplaint = /problema|reclamo|queja|ruido|fuga|luz|ascensor|basura|portón|petos|rata|humedad|gotera|roto|dañado|no funciona|no sirve|apesta|olor|insegur/i.test(userMessage);
  if (!maybeComplaint) return false;

  // But also check for negations / false positives
  const negations = /no hay problema|sin problema|todo bien|ningún problema|ya se arregló|ya lo arreglaron|gracias por arreglar/i.test(userMessage);
  if (negations) return false;

  return true;
}

// ── Portero on duty ──
function getPorteroOnDuty(dia, noche) {
  const hour = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/La_Paz" })
  ).getHours();
  return (hour >= 7 && hour < 19) ? dia : noche;
}

// ── Find oldest unpaid month ──
async function findOldestUnpaidMonth(residentId, buildingId, currentMonth) {
  const { data: paidMonths } = await supabase
    .from("payments")
    .select("month")
    .eq("resident_id", residentId)
    .eq("building_id", buildingId);

  const paidSet = new Set((paidMonths || []).map(p => p.month));

  // Check last 6 months
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleString("es", { month: "long", year: "numeric", timeZone: "America/La_Paz" });
    months.push(label);
  }

  // Return the oldest unpaid month
  for (const m of months) {
    if (!paidSet.has(m)) return m;
  }
  return currentMonth; // fallback
}

// ── Currency ──
function getCurrency(country) {
  const map = { PE: "S/", BO: "Bs", CO: "COP", AR: "ARS", MX: "MX$", CL: "CLP" };
  return map[country] || "$";
}

// ── Current month (Bolivia timezone) ──
function getCurrentMonth() {
  return new Date().toLocaleString("es", {
    month: "long",
    year: "numeric",
    timeZone: "America/La_Paz",
  });
}

// ── System prompt builder ──
function buildSystemPrompt({
  building, currency, currentMonth, resList, paid, pending,
  collected, totalExpenses, expenses, openTickets,
  diaPortero, nochePortero,
  person, isResident, isPortero, isAdmin,
  resident, portero, payments, alreadyPaidThisMonth,
  imageAnalysis,
}) {
  let prompt = `Eres el asistente virtual del edificio "${building.name}" en ${building.city}.
Tu nombre es "Bot ${building.name}". Respondes por WhatsApp. Siempre en español.
Tono amable, profesional, con emojis moderados. Máximo 4 líneas por respuesta salvo reportes.

═══ DATOS DEL EDIFICIO ═══
Moneda: ${currency}
Expensas mensuales: ${currency} ${building.monthly_fee}
Mes actual: ${currentMonth}
Pagados: ${paid}/${resList.length}
Pendientes: ${pending.map(r => r.unit + " " + r.name).join(", ") || "ninguno"}
Recaudado: ${currency} ${collected.toLocaleString()}
Gastos: ${currency} ${totalExpenses.toLocaleString()}
Saldo: ${currency} ${(collected - totalExpenses).toLocaleString()}
Portero día: ${diaPortero ? diaPortero.name + " 📞 " + diaPortero.phone : "—"}
Portero noche: ${nochePortero ? nochePortero.name + " 📞 " + nochePortero.phone : "—"}
Gastos recientes: ${(expenses || []).map(e => e.description + " " + currency + e.amount).join(" | ") || "ninguno"}
Reclamos abiertos: ${(openTickets || []).length > 0 ? openTickets.map(t => (t.unit || "?") + ": " + t.description).join(" | ") : "ninguno"}

═══ USUARIO ACTUAL ═══
Nombre: ${person.name}`;

  if (isResident) {
    const statusEmoji = resident.status === "paid" ? "PAGADO ✅" : resident.status === "pending" ? "EN VERIFICACIÓN ⏳" : "VENCIDO ❌";
    prompt += `
Rol: RESIDENTE — ${resident.unit}
Estado de pago: ${statusEmoji}
Historial: ${(payments || []).map(p => p.month + (p.verified ? " ✅" : " ⏳")).join(", ") || "sin pagos registrados"}`;

    if (alreadyPaidThisMonth) {
      prompt += `\n⚠️ YA PAGÓ ESTE MES. Si envía otro comprobante, dile amablemente que ya tiene registrado el pago de ${currentMonth}.`;
    }
  }

  if (isPortero) {
    prompt += `\nRol: PORTERO — Turno: ${portero.turno === "dia" ? "☀️ Día" : "🌙 Noche"}`;
  }

  if (isAdmin) {
    prompt += `\nRol: ADMINISTRADOR 👑
Como admin puede pedir:
- "resumen" → reporte completo del edificio formateado para WhatsApp
- "morosos" → lista de quienes deben
- "gastos" → desglose de gastos
- "verificar pago [unidad]" → confirmar un comprobante
- "anuncio: [texto]" → crear aviso para todos`;
  }

  if (imageAnalysis) {
    if (imageAnalysis.es_comprobante) {
      prompt += `\n\n═══ COMPROBANTE RECIBIDO ═══
El residente envió una foto que fue analizada automáticamente:
Monto: ${currency} ${imageAnalysis.monto || "?"}
Banco: ${imageAnalysis.banco || "?"}
Referencia: ${imageAnalysis.referencia || "?"}
Fecha: ${imageAnalysis.fecha || "?"}
${alreadyPaidThisMonth ? "⚠️ DUPLICADO — ya pagó este mes, NO registrar de nuevo." : "El pago quedó registrado pendiente de verificación del admin."}
Responde confirmando que recibiste el comprobante y que el admin lo verificará.`;
    } else {
      prompt += `\n\n[El residente envió una imagen que NO es un comprobante: ${imageAnalysis.descripcion || "?"}]`;
    }
  }

  prompt += `

═══ INSTRUCCIONES ═══
- Si reportan problema → confirma que anotaste el reclamo y que se avisó al portero.
- Si piden el portero → da nombre y teléfono de AMBOS turnos.
- Si el portero reporta novedad → confirma y dile que se notificó al admin.
- NUNCA inventes datos. Solo usa la información de arriba.
- Si no sabes algo → di que consultarás con el administrador.`;

  return prompt;
}
