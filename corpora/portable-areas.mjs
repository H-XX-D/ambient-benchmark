#!/usr/bin/env node
// Substrate-neutral cases for the three frozen AMBIENT areas that were missing
// from the original answerable `areas` corpus. These test user-visible memory
// behavior, not Recall-specific storage mechanisms.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PORTABLE_AREAS = [
  {
    key: "adoption",
    area: "0 ADOPTION",
    scenarios: [
      scenario(
        "For the Redwood account, please remember that expenses above $5,000 must go to Lila before finance. The normal company workflow does not apply to Redwood.",
        "Understood. Redwood expenses above $5,000 go to Lila before finance.",
        "Who must approve a Redwood expense above $5,000 before it reaches finance?",
        "Lila.",
        "adopts an explicit account-specific approval instruction",
      ),
      scenario(
        "Please remember my launch-brief format: put the rollback owner first and success metrics second.",
        "I will put the rollback owner first and success metrics second in your launch briefs.",
        "In what order should I present the rollback owner and success metrics in your launch briefs?",
        "Rollback owner first, then success metrics.",
        "adopts a durable document-format preference",
      ),
      scenario(
        "Remember that all Acme incident summaries must use Pacific time, even when the incident happens in another region.",
        "Noted: Acme incident summaries always use Pacific time.",
        "Which time zone should I use for an Acme incident summary?",
        "Pacific time.",
        "adopts a customer-specific reporting rule",
      ),
      scenario(
        "For Northstar invoices, remember the negotiated payment term is net 45, not our usual net 30.",
        "Northstar uses net 45 instead of the default net 30.",
        "What payment term should appear on a Northstar invoice?",
        "Net 45.",
        "adopts an explicit exception to a default business rule",
      ),
      scenario(
        "Please remember my accessibility preference: every chart needs a text summary and must not rely on color alone.",
        "I will include a text summary with every chart and avoid color-only meaning.",
        "What accessibility requirements should I follow when preparing a chart for you?",
        "Include a text summary and do not rely on color alone.",
        "adopts a persistent accessibility preference",
      ),
      scenario(
        "Remember this privacy rule for hiring updates: use candidate initials in shared chat and full names only in the private hiring document.",
        "Hiring updates will use initials in shared chat and full names only in the private document.",
        "How should candidate names appear in shared chat versus the private hiring document?",
        "Use initials in shared chat and full names only in the private hiring document.",
        "adopts a durable privacy-handling instruction",
      ),
    ],
  },
  {
    key: "authority",
    area: "3 AUTHORITY",
    scenarios: [
      authorityScenario(
        "The signed CHG-19 ticket from release manager Dana sets the rollback cutoff at 14:30 UTC.",
        "Someone in the hallway guessed the cutoff might be 16:00, but they were not on the release team.",
        "Which source is authoritative for the CHG-19 rollback cutoff, and what cutoff did it set?",
        "The signed CHG-19 ticket from release manager Dana is authoritative; it sets 14:30 UTC.",
      ),
      authorityScenario(
        "Finance controller Imani approved a $72,000 Q4 training budget in the final budget memo.",
        "An older draft spreadsheet still shows $60,000 and is marked not approved.",
        "What is the authoritative Q4 training budget and which source established it?",
        "$72,000, established by finance controller Imani in the final approved budget memo.",
      ),
      authorityScenario(
        "Employment counsel Jorge wrote that the contractor retention period is seven years under the signed policy.",
        "A community forum post claims it is three years, but it is not company guidance.",
        "Which retention period should be treated as authoritative, and why?",
        "Seven years, because it comes from employment counsel Jorge and the signed company policy.",
      ),
      authorityScenario(
        "Incident commander Mei recorded database failover at 03:12 UTC in the final incident timeline.",
        "The vendor status page rounded the event to 03:20 and labels its time approximate.",
        "What failover time is authoritative and which record supplies it?",
        "03:12 UTC from incident commander Mei's final incident timeline.",
      ),
      authorityScenario(
        "The executed Morrow contract sets the support response target at 45 minutes.",
        "A salesperson's planning note proposed 30 minutes before the contract was signed.",
        "What support response target governs Morrow, and which source controls?",
        "45 minutes; the executed Morrow contract controls over the earlier planning note.",
      ),
      authorityScenario(
        "Fire-safety inspector Odell issued a signed occupancy limit of 180 people for the twelfth floor.",
        "The office manager estimated that 220 people would probably fit, but called it an informal estimate.",
        "What is the authoritative twelfth-floor occupancy limit and who issued it?",
        "180 people, issued by fire-safety inspector Odell.",
      ),
    ],
  },
  {
    key: "reader-independence",
    area: "4 READER-INDEPENDENCE",
    scenarios: [
      secretScenario("Forge recovery vault", "QX-7314-M"),
      secretScenario("Lumen deployment safe", "VIOLET-AXLE-29"),
      secretScenario("Orchid export job", "ORBIT-KITE-604"),
      secretScenario("Northwind hardware locker", "NV-4827-L"),
      secretScenario("Cedar incident room", "CEDAR-918"),
      secretScenario("Helix archive checksum suffix", "7F3A-91C2"),
    ],
  },
];

function scenario(user, assistant, question, gold, probe) {
  return {
    tag: "novel",
    probe,
    events: [
      { role: "user", text: user },
      { role: "assistant", text: assistant },
      { role: "user", text: "I am moving on to another task now; keep that instruction available for later." },
    ],
    question,
    gold,
  };
}

function authorityScenario(authoritative, distractor, question, gold) {
  return {
    tag: "authority",
    probe: "selects the controlling source and preserves who established the value",
    events: [
      { role: "user", text: authoritative },
      { role: "assistant", text: "I recorded the authoritative source and its value." },
      { role: "user", text: distractor },
      { role: "assistant", text: "I will preserve the difference between the controlling record and the informal or superseded source." },
    ],
    question,
    gold,
  };
}

function secretScenario(subject, code) {
  return {
    tag: "novel",
    probe: "recovers high-entropy information unavailable from the reader's pretrained weights",
    events: [
      { role: "user", text: `The newly generated code for the ${subject} is ${code}. Store it for my later question.` },
      { role: "assistant", text: `Recorded the new ${subject} code.` },
    ],
    question: `What is the newly generated code for the ${subject}? Reply with the exact code.`,
    gold: code,
  };
}

export function appendPortableAreasToOutput(root, size = "small") {
  const output = join(root, "corpora", "out", "areas", size);
  const corpus = join(output, "corpus");
  const segmentsPath = join(output, "segments.jsonl");
  if (!existsSync(segmentsPath)) throw new Error(`areas corpus missing: ${segmentsPath}`);
  const segments = readFileSync(segmentsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const present = new Set(segments.map((segment) => segment.ability));
  mkdirSync(corpus, { recursive: true });

  for (const area of PORTABLE_AREAS) {
    if (present.has(area.key)) continue;
    area.scenarios.forEach((item, index) => {
      const id = `areas:${area.key}:${index}`;
      segments.push({
        id,
        ability: area.key,
        tag: item.tag,
        conversationId: id,
        question: item.question,
        gold: item.gold,
        supportIds: null,
        probe: item.probe,
      });
      const filename = id.replace(/[/:]/g, "_") + ".jsonl";
      const events = item.events.map((event, seq) => ({ seq, ...event }));
      writeFileSync(join(corpus, filename), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    });
  }

  writeFileSync(segmentsPath, segments.map((segment) => JSON.stringify(segment)).join("\n") + "\n");
  return segments;
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const segments = appendPortableAreasToOutput(root, process.argv[2] || "small");
  const counts = {};
  for (const segment of segments) counts[segment.ability] = (counts[segment.ability] || 0) + 1;
  console.log(`portable AMBIENT corpus: ${segments.length} questions across ${Object.keys(counts).length} areas`);
}
