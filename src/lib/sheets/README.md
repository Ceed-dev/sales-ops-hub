# Telegram Chat Sheet Sync

This document describes the data synchronization policy between **Firestore (`tg_chats` collection)** and **Google Sheets (Chat tab)**.

---

## Overview

The synchronization process is designed to **refresh the entire sheet (excluding headers)** with the latest data from Firestore on each run.  
This ensures complete consistency and simplifies logic by avoiding partial or per-row updates.

---

## Sync Policy

### 🔁 Full Overwrite Mode (Recommended)

Each sync run performs the following steps:

1. **Fetch all documents** from Firestore collection `tg_chats`.
2. **Clear all existing rows** in the `Chat` sheet _below the header row_ (A2 and onward).
3. **Write all fetched chat data** (`id`, `title`, etc.) back to the sheet in a single batch update.

This guarantees the sheet always reflects the exact state of Firestore.

---

## Advantages

| Aspect             | Full Overwrite           | Partial (Diff-Based) Update                |
| ------------------ | ------------------------ | ------------------------------------------ |
| Consistency        | ✅ Always accurate       | ⚠️ Risk of drift                           |
| Complexity         | ✅ Simple one-pass logic | ❌ Requires insert/update/delete detection |
| API Calls          | ✅ Minimal (1–2 calls)   | ❌ Multiple per change                     |
| Handling Deletions | ✅ Implicit              | ❌ Needs extra logic                       |
| Maintenance        | ✅ Easy and robust       | ❌ Harder to maintain                      |

---

## Sheet Structure

### `Meta` Sheet

| Key              | Value         | Description        |
| ---------------- | ------------- | ------------------ |
| `lastSyncAt`     | ISO timestamp | Last sync time     |
| `syncedCount`    | Number        | Total rows synced  |
| `syncDurationMs` | Number        | Sync duration (ms) |

### `Chat` Sheet

| COLUMN                | DESCRIPTION                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `ID`                  | Telegram group chat ID                                                                    |
| `TITLE`               | Chat title                                                                                |
| `PHASE`               | Current lifecycle phase of the chat (e.g., `BotAdded`, `ProposalSent`, `InvoiceSent`)     |
| `LATEST_MSG_FROM`     | Username of the sender of the latest message                                              |
| `LATEST_MSG_AT (JST)` | Timestamp of the latest message (JST, formatted as `YYYY/MM/DD HH:mm`)                    |
| `DAYS_SINCE_LAST_MSG` | Whole days since the latest message (integer, computed at sync time)                      |
| `LATEST_MSG_SUMMARY`  | Summary or snippet of the latest message                                                  |
| `BOT_ADDED_AT (JST)`  | Timestamp when the bot was first added to the chat (JST, from `botActivityHistory[0].ts`) |

---

## Chat Phase Lifecycle

The `PHASE` column reflects a high-level lifecycle of each chat.  
Phases are **set on creation** and **advance automatically** when specific follow-up notifications are created.

### Phase Types

- **BotAdded** – set when the bot is first added to the chat.
- **CalendlyLinkShared** – set when a `follow_up_calendly` job is created.
- **ProposalSent** – set when a `follow_up_proposal_1st` job is created.
- **AgreementSent** – set when a `follow_up_agreement_1st` job is created.
- **InvoiceSent** – set when a `follow_up_invoice_1st` job is created.

### Update Rules

- **Trigger:** phase advances **when the corresponding follow-up job is created** (existence-based).
- **Monotonic:** phases only move **forward** in this order:  
  `BotAdded → CalendlyLinkShared → ProposalSent → AgreementSent → InvoiceSent`
- **Idempotent:** repeated triggers with the **same message** do **not** change the phase.
- **Non-advancing jobs:** second reminders (e.g., `_2nd`) **do not** advance phase.
- **Stored shape:** Firestore stores the current phase as  
  `phase = { value: <ChatPhase>, ts: <Timestamp>, messageId: <string> }`.

### Mapping (Jobs → Phase)

| Follow-up Job Type              | Phase                |
| ------------------------------- | -------------------- |
| `follow_up_bot_join_call_check` | `BotAdded`           |
| `follow_up_calendly`            | `CalendlyLinkShared` |
| `follow_up_proposal_1st`        | `ProposalSent`       |
| `follow_up_agreement_1st`       | `AgreementSent`      |
| `follow_up_invoice_1st`         | `InvoiceSent`        |

> On new chat creation, `phase.value` starts as `BotAdded`.  
> During sheet sync, we display `phase.value` (and compute `DAYS_SINCE_LAST_MSG` separately).

---

## Future Extensions

- Additional columns (e.g. `memberCount`, `latestMessage`, `updatedAt`) can be added to both Firestore and the sheet.
- If the number of rows grows large, the process can chunk data (e.g. 10k rows per batch).

---

## Summary

> **Keep it simple and consistent** — always rebuild the data table from Firestore for every sync run.  
> This approach minimizes risk, reduces API usage, and ensures the sheet reflects the latest true state.
