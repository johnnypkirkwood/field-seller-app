require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { sfQuery, sfCreate, sfUpdate } = require('./sf');

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


// ── M4b: Post-visit logging agent ─────────────────────────
// /api/log-visit proposes structured updates from a rep's note.
// /api/log-visit/commit executes the approved proposal.
// Propose/commit split because mutations span Activity, ContentNote,
// Opportunity, and CampaignMember — rep verifies before writes.

const LOG_VISIT_TOOLS = [
  {
    name: 'getAppointmentContext',
    description: "Returns the ServiceAppointment plus its parent Account and primary Contact. Call this first.",
    input_schema: {
      type: 'object',
      required: ['appointmentId'],
      properties: { appointmentId: { type: 'string' } },
    },
  },
  {
    name: 'queryOpenOpportunities',
    description: 'Returns open (IsClosed=false) opportunities on a given Account.',
    input_schema: {
      type: 'object',
      required: ['accountId'],
      properties: { accountId: { type: 'string' } },
    },
  },
  {
    name: 'searchCampaignsByKeyword',
    description: "Searches active Campaigns whose Name contains the keyword (case-insensitive). Use sparingly — pick a single distinctive token from the rep's note (e.g. 'Phillies'), not full phrases.",
    input_schema: {
      type: 'object',
      required: ['keyword'],
      properties: { keyword: { type: 'string' } },
    },
  },
  {
    name: 'submitProposal',
    description: 'Submit the full proposal. Always your last action. Always include activity and completeAppointment; the others are optional.',
    input_schema: {
      type: 'object',
      required: ['brief', 'activity', 'completeAppointment'],
      properties: {
        brief: {
          type: 'string',
          description: "Warm 1-2 sentence message to the rep. Something like 'I parsed your note. Here's what I'd update — does this look right?'",
        },
        activity: {
          type: 'object',
          required: ['contactId', 'subject', 'description'],
          properties: {
            contactId:   { type: 'string' },
            subject:     { type: 'string', description: "Short — e.g. 'Visit summary — Bob Isis'" },
            description: { type: 'string', description: 'Conversation summary in plain prose, 1-3 sentences.' },
          },
        },
        contentNotes: {
          type: 'array',
          description: "Personal-interest notes for the contact. Title is short ('Phillies fan'); body is one sentence of context.",
          items: {
            type: 'object',
            required: ['contactId', 'title', 'body'],
            properties: {
              contactId: { type: 'string' },
              title:     { type: 'string' },
              body:      { type: 'string' },
            },
          },
        },
        opportunityUpdates: {
          type: 'array',
          items: {
            type: 'object',
            required: ['opportunityId', 'fields'],
            properties: {
              opportunityId: { type: 'string' },
              fields: {
                type: 'object',
                description: 'Map of Salesforce field API names → new values. E.g. { CloseDate: "2026-07-31" }',
              },
              reason: { type: 'string', description: 'One-line why, for the rep to verify.' },
            },
          },
        },
        campaignMembers: {
          type: 'array',
          items: {
            type: 'object',
            required: ['campaignId', 'contactId'],
            properties: {
              campaignId: { type: 'string' },
              contactId:  { type: 'string' },
              status:     { type: 'string', description: "Default 'Sent'." },
            },
          },
        },
        completeAppointment: {
          type: 'object',
          required: ['appointmentId'],
          properties: { appointmentId: { type: 'string' } },
        },
      },
    },
  },
];

function escapeSoql(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function handleGetAppointmentContext({ appointmentId }) {
  const safeId = escapeSoql(appointmentId);
  const sa = sfQuery(`
    SELECT Id, Subject, Status, ParentRecordId, ContactId,
           Account.Id, Account.Name, Account.BillingCity, Account.BillingState,
           Contact.Id, Contact.FirstName, Contact.LastName, Contact.Title, Contact.Email
    FROM ServiceAppointment
    WHERE Id = '${safeId}' LIMIT 1
  `);
  if (!sa.records.length) return { error: 'ServiceAppointment not found' };
  const r = sa.records[0];
  return {
    appointment: {
      id: r.Id,
      subject: r.Subject,
      status:  r.Status,
      accountId: r.Account?.Id || r.ParentRecordId,
      accountName: r.Account?.Name || null,
      accountCity: r.Account?.BillingCity || null,
      accountState: r.Account?.BillingState || null,
      contactId: r.Contact?.Id || r.ContactId || null,
      contactFirstName: r.Contact?.FirstName || null,
      contactLastName:  r.Contact?.LastName  || null,
      contactTitle:     r.Contact?.Title || null,
      contactEmail:     r.Contact?.Email || null,
    },
  };
}

function handleQueryOpenOpportunities({ accountId }) {
  const safeId = escapeSoql(accountId);
  const r = sfQuery(`
    SELECT Id, Name, StageName, Amount, CloseDate, Description
    FROM Opportunity
    WHERE AccountId = '${safeId}' AND IsClosed = false
    ORDER BY CloseDate ASC NULLS LAST
  `);
  return { opportunities: r.records.map(o => ({
    id: o.Id, name: o.Name, stage: o.StageName,
    amount: o.Amount, closeDate: o.CloseDate, description: o.Description,
  })) };
}

function handleSearchCampaigns({ keyword }) {
  const safe = escapeSoql(keyword);
  const r = sfQuery(`
    SELECT Id, Name, Type, Status, StartDate, EndDate
    FROM Campaign
    WHERE IsActive = true AND Name LIKE '%${safe}%'
    ORDER BY StartDate ASC NULLS LAST
    LIMIT 10
  `);
  return { campaigns: r.records.map(c => ({
    id: c.Id, name: c.Name, type: c.Type,
    status: c.Status, startDate: c.StartDate, endDate: c.EndDate,
  })) };
}

app.post('/api/log-visit', async (req, res) => {
  const { note, appointmentId, history = [] } = req.body;
  if (!history.length) {
    if (!note)          return res.status(400).json({ ok: false, error: 'note required' });
    if (!appointmentId) return res.status(400).json({ ok: false, error: 'appointmentId required' });
  }

  const today = new Date().toISOString().slice(0, 10);

  const systemPrompt = `You are an AI assistant helping Johnny Kirkwood, a field sales rep, log what just happened on a sales visit.

The rep speaks a quick post-visit note. You translate it into a structured proposal of CRM updates. The rep verifies and approves before anything is written, so your job is to capture intent precisely — don't invent details, don't add fluff.

WORKFLOW:
1. Call getAppointmentContext with the provided appointmentId to learn the account, contact, and SA.
2. Call queryOpenOpportunities for that account if the note mentions deal timing, close dates, stage, or amount changes.
3. Call searchCampaignsByKeyword for a distinctive token from the note ONLY IF the rep mentioned a specific event/outing/invite (e.g. "Phillies", "Dreamforce"). Pick one token, not a phrase. Skip otherwise.
4. Call submitProposal once with the full plan. Required: an activity (Task summarizing the conversation, attached to the contact) and completeAppointment (the SA the rep just finished). Optional: contentNotes for personal interests, opportunityUpdates for deal changes, campaignMembers for events the rep mentioned.

CLARIFICATION:
- If the note mentions a deal change but multiple open opps could match, ask ONE clarifying question and stop. Same for ambiguous campaign matches.
- If the note is just a general summary with no specific updates, that's fine — submit a proposal with just activity + completeAppointment.

DATE INTERPRETATION:
- Today is ${today}. "Close in July" with no year → ${today.slice(0, 4)}-07-31 (last day of the month). "End of Q3" → 2026-09-30. Be conservative and pick the end of the period.

CONTENT NOTE STYLE:
- Title: 2-4 words, the topic ("Phillies fan", "Daughter at Stanford").
- Body: one factual sentence. No editorializing.
- ALWAYS create a ContentNote when the rep observes a personal-interest reaction — e.g. "he was stoked about X", "she's a big Y fan", "his daughter is at Z". This is true even when X is something you're also adding the contact to as a campaign member: the campaign captures the invite, the ContentNote captures the durable fact about the contact for future reference.

ACTIVITY STYLE:
- Subject: short — "Visit summary — <Contact First Last>" or "Conversation re: <topic>".
- Description: 1-3 sentences capturing what was actually said. No invented details.`;

  const messages = [
    ...history,
    ...(history.length ? [] : [{
      role: 'user',
      content: `ServiceAppointment Id: ${appointmentId}\n\nRep's note:\n${note}`,
    }]),
  ];

  try {
    let proposal = null;

    while (true) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        tools: LOG_VISIT_TOOLS,
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
            if (tu.name === 'getAppointmentContext') {
              result = handleGetAppointmentContext(tu.input);
            } else if (tu.name === 'queryOpenOpportunities') {
              result = handleQueryOpenOpportunities(tu.input);
            } else if (tu.name === 'searchCampaignsByKeyword') {
              result = handleSearchCampaigns(tu.input);
            } else if (tu.name === 'submitProposal') {
              proposal = tu.input;
              result = { ok: true, received: true };
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
          return res.json({
            ok: true,
            status: 'proposed',
            brief: proposal.brief,
            proposal: {
              activity:            proposal.activity,
              contentNotes:        proposal.contentNotes        || [],
              opportunityUpdates:  proposal.opportunityUpdates  || [],
              campaignMembers:     proposal.campaignMembers     || [],
              completeAppointment: proposal.completeAppointment,
            },
            history: messages,
          });
        }
      }
    }
  } catch (err) {
    console.error('log-visit error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── /api/log-visit/commit ────────────────────────────────
// Executes a proposal returned from /api/log-visit. Continues on partial
// failure — returns counts of what landed plus any errors.

app.post('/api/log-visit/commit', async (req, res) => {
  const { proposal } = req.body;
  if (!proposal) return res.status(400).json({ ok: false, error: 'proposal required' });

  const executed = { activity: 0, contentNotes: 0, opportunityUpdates: 0, campaignMembers: 0, completeAppointment: 0 };
  const errors = [];
  const today = new Date().toISOString().slice(0, 10);

  // 1. Activity (Task on contact)
  if (proposal.activity) {
    try {
      const a = proposal.activity;
      await sfCreate('Task', {
        WhoId:        a.contactId,
        Subject:      a.subject,
        Description:  a.description,
        Status:       'Completed',
        ActivityDate: today,
        OwnerId:      REP.userId,
      });
      executed.activity = 1;
    } catch (err) {
      console.error('Task create failed:', err.message);
      errors.push({ type: 'activity', error: err.message });
    }
  }

  // 2. ContentNotes — create note, then link to contact via ContentDocumentLink
  for (const n of proposal.contentNotes || []) {
    try {
      const noteHtml = `<p>${n.body.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]))}</p>`;
      const note = await sfCreate('ContentNote', {
        Title:   n.title,
        Content: Buffer.from(noteHtml, 'utf8').toString('base64'),
        OwnerId: REP.userId,
      });
      await sfCreate('ContentDocumentLink', {
        ContentDocumentId: note.id,
        LinkedEntityId:    n.contactId,
        ShareType:         'V',
      });
      executed.contentNotes++;
    } catch (err) {
      console.error('ContentNote create failed:', err.message);
      errors.push({ type: 'contentNote', title: n.title, error: err.message });
    }
  }

  // 3. Opportunity updates
  for (const o of proposal.opportunityUpdates || []) {
    try {
      await sfUpdate('Opportunity', o.opportunityId, o.fields);
      executed.opportunityUpdates++;
    } catch (err) {
      console.error('Opportunity update failed:', err.message);
      errors.push({ type: 'opportunityUpdate', opportunityId: o.opportunityId, error: err.message });
    }
  }

  // 4. Campaign members
  for (const cm of proposal.campaignMembers || []) {
    try {
      await sfCreate('CampaignMember', {
        CampaignId: cm.campaignId,
        ContactId:  cm.contactId,
        Status:     cm.status || 'Sent',
      });
      executed.campaignMembers++;
    } catch (err) {
      console.error('CampaignMember create failed:', err.message);
      errors.push({ type: 'campaignMember', contactId: cm.contactId, error: err.message });
    }
  }

  // 5. Complete the SA
  if (proposal.completeAppointment?.appointmentId) {
    try {
      await sfUpdate('ServiceAppointment', proposal.completeAppointment.appointmentId, {
        Status: 'Completed',
      });
      executed.completeAppointment = 1;
    } catch (err) {
      console.error('SA complete failed:', err.message);
      errors.push({ type: 'completeAppointment', error: err.message });
    }
  }

  res.json({ ok: errors.length === 0, executed, ...(errors.length ? { errors } : {}) });
});


app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
