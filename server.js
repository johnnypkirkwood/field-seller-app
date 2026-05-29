require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { sfQuery, sfCreate } = require('./sf');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Rep identity cache (single-user demo, hardcoded) ──────
const REP = {
  userId:             '005Hs00000Ie1mpIAB',
  serviceResourceId:  '0HnHs000001UnIhKAK',
  serviceTerritoryId: '0HhHs000001UUGoKAO',
  serviceTerritoryName: 'San Francisco',
  workTypeId: null,
};

// Look up "Sales Visit" WorkType once at startup
try {
  const wt = sfQuery("SELECT Id FROM WorkType WHERE Name = 'Sales Visit' LIMIT 1");
  REP.workTypeId = wt.records[0]?.Id ?? null;
  console.log('WorkType (Sales Visit):', REP.workTypeId || 'NOT FOUND');
} catch (e) {
  console.error('WorkType lookup failed at startup:', e.message);
}

// ── Existing endpoints ────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Field Seller backend is running',
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    sfAlias: process.env.SF_ORG_ALIAS || 'fielddev',
  });
});

app.get('/api/appointments', async (req, res) => {
  try {
    const { runId } = req.query;
    const runIdClause = runId
      ? `Demo_Run_Id__c = '${String(runId).replace(/'/g, "\\'")}' AND `
      : '';
    const result = await sfQuery(`
      SELECT Id, AppointmentNumber, Subject, Status,
             SchedStartTime, SchedEndTime,
             AccountId, Account.Name, ContactId, Contact.Name,
             ServiceTerritoryId, Street, City, State, PostalCode,
             FSL__InternalSLRGeolocation__Latitude__s,
             FSL__InternalSLRGeolocation__Longitude__s,
             Demo_Run_Id__c
      FROM ServiceAppointment
      WHERE ${runIdClause}CreatedDate = TODAY
      ORDER BY SchedStartTime ASC NULLS LAST, CreatedDate ASC
    `);
    res.json({ ok: true, appointments: result.records });
  } catch (err) {
    console.error('appointments error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ mapboxToken: process.env.MAPBOX_TOKEN || '' });
});

// Daily brief — calls Claude, caches 1 hour
let briefCache = null;

app.post('/api/daily-brief', async (req, res) => {
  const now = Date.now();
  if (briefCache && now - briefCache.ts < 60 * 60 * 1000) {
    return res.json({ brief: briefCache.brief, generatedAt: briefCache.generatedAt });
  }

  const mockContext = `
Rep: Johnny Kirkwood, field sales
Open opportunities:
  - Isis Toyota - lift replacement ($48,000, close Sept 30, 12 days no activity)
  - Capital One - fleet expansion ($220,000, close Dec 31, 31 days no activity)
  - F5 Networks - software renewal ($34,000, close Jul 15, 5 days no activity)
Weather: partly cloudy, 72°F, good driving day
Today: Thursday
  `.trim();

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: "You're a calm, helpful assistant briefing a field sales rep on their morning. Keep it under 120 words, conversational, no bullet points. Surface what matters most.",
      messages: [{ role: 'user', content: mockContext }],
    });

    const brief = msg.content[0].type === 'text' ? msg.content[0].text : '';
    const generatedAt = new Date().toISOString();
    briefCache = { brief, generatedAt, ts: now };
    res.json({ brief, generatedAt });
  } catch (err) {
    console.error('daily-brief error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Open opps — top 2 unclosed, stale-first
app.get('/api/open-opps', async (req, res) => {
  try {
    const result = sfQuery(`
      SELECT Name, Account.Name, Amount, LastActivityDate
      FROM Opportunity
      WHERE IsClosed = false
      ORDER BY LastActivityDate ASC NULLS FIRST
      LIMIT 2
    `);
    const today = new Date();
    const opps = result.records.map(o => {
      let daysSince = null;
      if (o.LastActivityDate) {
        const diff = today - new Date(o.LastActivityDate);
        daysSince = Math.floor(diff / 86400000);
      }
      return {
        name: o.Name,
        account: o.Account ? o.Account.Name : '',
        amount: o.Amount,
        daysSince,
      };
    });
    res.json({ ok: true, opps });
  } catch (err) {
    console.error('open-opps error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── M2: Plan-day agent tools ──────────────────────────────

const PLAN_TOOLS = [
  {
    name: 'queryTopAccountsByLastVisit',
    description: 'Returns up to 10 accounts owned by the rep, sorted by days since last visit (most stale first). Includes billing address and primary contact.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getRepTerritory',
    description: "Returns the rep's ServiceTerritory ID, ServiceResource ID, and Sales Visit WorkType ID needed to create service appointments.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'submitProposal',
    description: 'Submit the final day plan proposal once you have gathered all account and territory data. This is always your last action.',
    input_schema: {
      type: 'object',
      required: ['brief', 'appointments'],
      properties: {
        brief: {
          type: 'string',
          description: 'Warm, concise 2-3 sentence summary of the plan for the rep.',
        },
        appointments: {
          type: 'array',
          items: {
            type: 'object',
            required: ['accountId', 'accountName', 'subject', 'workTypeId', 'serviceTerritoryId', 'earliestStartTime', 'dueDate'],
            properties: {
              accountId:          { type: 'string' },
              accountName:        { type: 'string' },
              contactId:          { type: ['string', 'null'] },
              contactName:        { type: ['string', 'null'] },
              subject:            { type: 'string' },
              workTypeId:         { type: 'string' },
              serviceTerritoryId: { type: 'string' },
              earliestStartTime:  { type: 'string', description: 'ISO 8601' },
              dueDate:            { type: 'string', description: 'ISO 8601' },
              street:             { type: 'string' },
              city:               { type: 'string' },
              state:              { type: 'string' },
              postalCode:         { type: 'string' },
              daysSinceLastVisit: { type: 'number' },
            },
          },
        },
        absence: {
          type: ['object', 'null'],
          properties: {
            start:  { type: 'string', description: 'ISO 8601' },
            end:    { type: 'string', description: 'ISO 8601' },
            street: { type: 'string' },
            city:   { type: 'string' },
            state:  { type: 'string' },
          },
        },
      },
    },
  },
];

function handleQueryAccounts() {
  const result = sfQuery(`
    SELECT Id, Name, Type, BillingStreet, BillingCity, BillingState,
           BillingPostalCode, SDO_MAPS_Days_Since_Last_Visit__c,
           (SELECT Id, Name FROM Contacts ORDER BY CreatedDate ASC LIMIT 1)
    FROM Account
    WHERE OwnerId = '${REP.userId}'
      AND Type != null
      AND SDO_MAPS_Days_Since_Last_Visit__c != null
    ORDER BY SDO_MAPS_Days_Since_Last_Visit__c DESC NULLS LAST
    LIMIT 10
  `);
  return result.records.map(a => ({
    accountId:          a.Id,
    accountName:        a.Name,
    type:               a.Type,
    street:             a.BillingStreet   || '',
    city:               a.BillingCity     || '',
    state:              a.BillingState    || '',
    postalCode:         a.BillingPostalCode || '',
    daysSinceLastVisit: a.SDO_MAPS_Days_Since_Last_Visit__c,
    contactId:          a.Contacts?.records?.[0]?.Id   ?? null,
    contactName:        a.Contacts?.records?.[0]?.Name ?? null,
  }));
}

function handleGetTerritory() {
  return {
    serviceResourceId:   REP.serviceResourceId,
    serviceTerritoryId:  REP.serviceTerritoryId,
    serviceTerritoryName: REP.serviceTerritoryName,
    workTypeId:          REP.workTypeId,
  };
}

// ── RSO stub ─────────────────────────────────────────────
// TODO M3.5: invoke RSO Flow here
// Will be: POST to /services/data/v66.0/actions/custom/flow/<FlowName>
// with { inputs: [{ scheduledDate: today }] }
async function invokeRSO(appointmentIds) {
  console.log('[RSO STUB] would optimize:', appointmentIds);
  return { ok: true, stubbed: true };
}

// ── POST /api/plan-day ────────────────────────────────────
// Accepts { message, history? } — runs tool-use agent loop,
// creates records on submitProposal, returns immediately.
// Returns { ok, status: 'scheduling'|'clarifying', message, appointmentIds?, history }

app.post('/api/plan-day', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: 'message required' });
  if (!REP.workTypeId) {
    return res.status(503).json({ ok: false, error: 'WorkType "Sales Visit" not found in org — check Salesforce setup.' });
  }

  const runId = crypto.randomUUID();
  const now = new Date();
  const todayAt5PT = new Date(now.toISOString().slice(0, 10) + 'T17:00:00-07:00').toISOString();

  const systemPrompt = `You are an AI assistant helping Johnny Kirkwood, a field sales rep, plan their day.

Your goal: create service appointments (sales visits) and optionally a ResourceAbsence calendar block by calling submitProposal.

WORKFLOW:
1. Read the rep's message. If you already have enough to build a plan (accounts to visit, any time constraints), go straight to step 2. Only ask a clarifying question if a critical constraint is completely missing — and ask only ONE question.
2. Call queryTopAccountsByLastVisit and getRepTerritory (you may call both in the same response).
3. Once you have the data, call submitProposal with the complete plan.

APPOINTMENT FIELD RULES:
- subject: "Sales visit — <Account Name>"
- earliestStartTime: ${now.toISOString()} (now — RSO will sequence stops)
- dueDate: if the rep specified a pickup/meeting end time, use that time minus 15 minutes for ALL appointments. Otherwise use ${todayAt5PT}.
- workTypeId and serviceTerritoryId: take from getRepTerritory response.
- street/city/state/postalCode: from the account's billing address.
- contactId: use the one returned from queryTopAccountsByLastVisit; null is fine if absent.

ABSENCE RULES:
- Create an absence if the rep mentions a pickup, appointment, or personal block at a specific time.
- start: the time the rep mentioned. end: start + 30 minutes.
- Use whatever location the rep gave — no need to ask for more specifics if they named a city.
- If no location given at all, ask the rep once before proceeding.

When you call submitProposal, the records are created immediately and RSO will sequence the stops. Your brief should say something like "I've queued up your route — RSO is sequencing the stops now." Keep it warm, concise, 2-3 sentences. Don't list every account name.`;

  const messages = [...history, { role: 'user', content: message }];

  try {
    let proposal = null;

    while (true) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        tools: PLAN_TOOLS,
        messages,
      });

      if (response.stop_reason === 'end_turn') {
        messages.push({ role: 'assistant', content: response.content });
        const text = response.content.find(c => c.type === 'text')?.text || '';
        return res.json({ ok: true, status: 'clarifying', message: text, history: messages });
      }

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });

        const toolUses = response.content.filter(c => c.type === 'tool_use');
        const toolResults = [];

        for (const tu of toolUses) {
          let result;
          try {
            if (tu.name === 'queryTopAccountsByLastVisit') {
              result = handleQueryAccounts();
            } else if (tu.name === 'getRepTerritory') {
              result = handleGetTerritory();
            } else if (tu.name === 'submitProposal') {
              proposal = tu.input;
              // Create records in parallel
              const created = { appointments: [], absence: null };
              const errors  = [];

              const apptCreates = (proposal.appointments || []).map(appt =>
                sfCreate('ServiceAppointment', {
                  ParentRecordId:     appt.accountId,
                  ContactId:          appt.contactId || undefined,
                  Subject:            appt.subject,
                  WorkTypeId:         appt.workTypeId,
                  ServiceTerritoryId: appt.serviceTerritoryId,
                  EarliestStartTime:  appt.earliestStartTime,
                  DueDate:            appt.dueDate,
                  Street:             appt.street     || '',
                  City:               appt.city       || '',
                  State:              appt.state      || '',
                  PostalCode:         appt.postalCode || '',
                  Demo_Run_Id__c:     runId,
                }).then(r => ({ kind: 'appt', appt, r }))
                  .catch(err => ({ kind: 'appt', appt, err }))
              );

              const absencePromise = proposal.absence
                ? sfCreate('ResourceAbsence', {
                    ResourceId: REP.serviceResourceId,
                    Type:       'Personal',
                    Start:      proposal.absence.start,
                    End:        proposal.absence.end,
                    Street:     proposal.absence.street || '',
                    City:       proposal.absence.city   || '',
                    State:      proposal.absence.state  || '',
                    Demo_Run_Id__c: runId,
                  }).then(r => ({ kind: 'absence', r }))
                    .catch(err => ({ kind: 'absence', err }))
                : null;

              const t0 = Date.now();
              const settled = await Promise.all(
                absencePromise ? [...apptCreates, absencePromise] : apptCreates
              );
              console.log(`[plan-day] ${settled.length} writes in ${Date.now() - t0}ms`);

              for (const s of settled) {
                if (s.kind === 'appt') {
                  if (s.err) {
                    console.error(`SA create failed for ${s.appt.accountName}:`, s.err.message);
                    errors.push({ type: 'appointment', accountName: s.appt.accountName, error: s.err.message });
                  } else {
                    created.appointments.push({ id: s.r.id, accountName: s.appt.accountName });
                  }
                } else if (s.kind === 'absence') {
                  if (s.err) {
                    console.error('ResourceAbsence create failed:', s.err.message);
                    errors.push({ type: 'absence', error: s.err.message });
                  } else {
                    created.absence = { id: s.r.id };
                  }
                }
              }

              const appointmentIds = created.appointments.map(a => a.id);
              await invokeRSO(appointmentIds);

              result = { ok: true, created, ...(errors.length ? { errors } : {}) };
            } else {
              result = { error: `Unknown tool: ${tu.name}` };
            }
          } catch (toolErr) {
            result = { error: toolErr.message };
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result),
          });
        }

        messages.push({ role: 'user', content: toolResults });

        if (proposal) {
          const appointmentIds = toolResults
            .map(tr => { try { return JSON.parse(tr.content); } catch { return null; } })
            .filter(r => r?.created?.appointments)
            .flatMap(r => r.created.appointments.map(a => a.id));

          return res.json({
            ok: true,
            status: 'scheduling',
            message: proposal.brief,
            appointmentIds,
            runId,
            history: messages,
          });
        }
      }
    }
  } catch (err) {
    console.error('plan-day error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
