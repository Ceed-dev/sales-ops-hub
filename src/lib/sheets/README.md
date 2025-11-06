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

| COLUMN               | DESCRIPTION                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `ID`                 | Telegram group chat ID                                                                    |
| `TITLE`              | Chat title                                                                                |
| `PHASE`              | Current lifecycle phase of the chat (e.g., `BotAdded`, `ProposalSent`, `InvoiceSent`)     |
| `LATEST_MSG_FROM`    | Username of the sender of the latest message                                              |
| `LATEST_MSG_AT`      | Timestamp of the latest message (JST, formatted as `YYYY/MM/DD HH:mm JST`)                |
| `LATEST_MSG_SUMMARY` | Summary or snippet of the latest message                                                  |
| `BOT_ADDED_AT`       | Timestamp when the bot was first added to the chat (JST, from `botActivityHistory[0].ts`) |

---

## Future Extensions

- Additional columns (e.g. `memberCount`, `latestMessage`, `updatedAt`) can be added to both Firestore and the sheet.
- If the number of rows grows large, the process can chunk data (e.g. 10k rows per batch).

---

## Summary

> **Keep it simple and consistent** — always rebuild the data table from Firestore for every sync run.  
> This approach minimizes risk, reduces API usage, and ensures the sheet reflects the latest true state.
