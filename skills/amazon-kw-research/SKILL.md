---
name: amazon-keyword-research
description: Amazon keyword research for product listings and PPC. Use when asked to do keyword research, find keywords for a product, build keyword lists, or analyze search terms for Amazon products.
requires:
  connections:
    - keepa
    - jungle_scout
    - google_drive
    - google_sheets
---

# Amazon Keyword Research Skill

## Overview
Conduct keyword research for Amazon products using Keepa (for ASIN/competitor data) and Jungle Scout (for keyword metrics). Output a structured Google Sheet workbook with raw data, filtered keywords, root keyword analysis, and PPC keyword lists.

> **Before any API call here, read the per-service skills first** — they contain the canonical endpoint specs and curl examples you need:
> - **Keepa:** see `skills/keepa/SKILL.md` (vended key via gateway, `?key=`-based auth).
> - **Jungle Scout:** see `skills/jungle_scout/SKILL.md` (transparent reverse proxy, `Authorization` header + extra headers).
>
> Each skill has a `toolspec` YAML block listing every endpoint, method, params, and the exact auth flow — parse those for ground truth instead of guessing endpoint paths.

## Process

### 1. Identify Competitor ASINs
- Use Keepa (see `skills/keepa/SKILL.md`) to find top competitors for the product category — start with `/search` by keyword, or `/bestsellers` for a category, then `/product` for details.
- Select 5-10 ASINs that are direct competitors (same product type, similar price range)
- Include a mix: top sellers + rising products

### 2. Pull Keyword Data
- Use Jungle Scout's `keywords_by_asin` endpoint (see `skills/jungle_scout/SKILL.md`) for each competitor ASIN
- For exploration around a known phrase, use `keywords_by_keyword` instead
- Export: keyword phrase, search volume, SV trend, PPC bids, competing products, sponsored ASINs, ranking competitors

### 3. Build the Workbook

#### Sheet: Raw Data
- All keywords from Cerebro, unfiltered
- Include all columns from the source

#### Sheet: Filtered Keywords
- Only includes **relevant** keywords — filtered by the Ranking Competitors relevancy test
- **Relevancy test:** A keyword is relevant if ≥30% of the competitor ASINs rank for it. With 10 competitors that's ≥3; with 7-8 competitors that's ≥2. Adjust threshold based on competitor count.
- "Raw Data" = full Cerebro dump (all columns, untouched). "Filtered Keywords" = relevant keywords only, simplified columns + root keyword classification + color coding.
- Add a "Root Keyword" column that classifies each keyword by its root keyword group
- Color-code rows by root keyword (matching the Root Keywords sheet colors)
- Unclassified keywords stay white — this shows RKW coverage gaps

**Why filter by Ranking Competitors:**
- Cerebro pulls keywords from competitor ASINs, but competitors sell multiple product types
- A competitor might rank for "card sleeves" but that doesn't make it relevant for deck boxes
- Ranking Competitors count tells you how many of YOUR selected competitors actually rank for that keyword
- If only 1 out of 7 competitors ranks for it, it's probably not relevant to the product category

#### Sheet: Root Keywords
- Group keywords into root keyword categories
- Each root keyword gets a distinct pastel background color
- Columns: Root Keyword, Total Search Volume, # Variants, Top 5 Variants, Avg PPC Bid, Notes

**Root Keyword Rules:**
- Root keywords must be **specific to the product type** — not generic category terms
- ❌ BAD: "mtg accessories", "magic the gathering accessories", "card protector" (too generic, captures unrelated products)
- ❌ BAD: "card sleeves", "booster box" (adjacent product categories, not the product being sold)
- ✅ GOOD: "deck box", "mtg deck box", "commander deck box", "card storage box", "magnetic box"
- Root keywords should describe **the product you're selling**, not adjacent products that share competitors
- **NO catch-all "other" bucket.** Leave unmatched keywords with an empty Root Keyword field (uncolored). This makes gaps immediately visible — if too many rows are uncolored, you know you're missing root keywords.
- Check the "Top 5 Variants" — if they include unrelated products (e.g., mahjong when researching MTG), the root keyword is too broad
- When a keyword matches multiple root keywords, assign it to the **most specific** (longest match)
- Unclassified keywords stay white/uncolored in Raw Keywords — this is a feature, not a bug. It shows coverage gaps at a glance.

#### Sheet: Never Keywords (NKWs)
- **Single words** (not phrases) that should be negated in BROAD PPC campaigns
- A word is an NKW if we're SURE that a search term containing it does NOT describe our product — meaning the searcher would not buy our product
- NKWs are about **product fit**, not niche. Example for a deck box:
  - ✅ NKW: "dual" (our deck box holds one deck, not two)
  - ✅ NKW: "binder" (completely different product format)
  - ❌ NOT NKW: "pokemon" (someone could use our deck box for pokemon cards)
  - ❌ NOT NKW: "yugioh" (same logic — different game, but same product use case)
- Columns: Word, Reason, Source Keywords (examples of keywords containing this word)
- **Competitor brand names** are NKWs — if someone searches "gamegenic deck box" they want that specific brand, not ours
- Be conservative — when in doubt, do NOT add as NKW. False negatives (missing an NKW) waste some ad spend; false positives (wrongly blocking a word) lose sales.

**How NKWs are used in PPC:**
- EXACT campaign: targets each Filtered Keyword as exact match
- BROAD campaign: targets each Filtered Keyword as broad match, negating:
  1. All Filtered Keywords (already in EXACT)
  2. All Never Keywords (would produce irrelevant search terms)
- Goal of BROAD: discover new long-tail keywords based on Master List words

#### Sheet: Master List
- The final curated keyword list that feeds directly into PPC campaigns
- Formula: `master_list = filtered_keywords × root_keywords / never_keywords`
  - `×` (multiply/overlap): only Filtered Keywords that ARE classified under a Root Keyword
  - `/` (divide/remove): exclude any keyword containing a word from the Never Keywords list
- Contains the same data columns as Filtered Keywords (minus the Root Keyword column)
- This is the sheet that gets used for EXACT and BROAD PPC campaigns

#### Sheet: Single Words
- Individual word frequency analysis from the **Master List** (not raw data)
- Columns: Word, Count (how many Master List keywords contain this word)
- Sorted by count descending
- Helps identify core vocabulary for listings and potential missing NKWs

#### Sheet: Amazon Listing
- Suggested Amazon product title and 5 bullet points, optimized for keyword coverage
- **Goal:** Include as many Single Words as possible while keeping the text readable, relevant, and compliant with Amazon guidelines

**Title:**
- Amazon max ~200 characters — aim for 190-200
- Must contain all high-count words from Single Words (the most important keywords)
- Higher-count words should appear earlier in the title
- Format: `Brand - Product Type - Key Features - Use Case/Compatibility`
- Must be readable and make sense — not keyword-stuffed

**Bullet Points (5):**
- Each bullet covers a different angle: specs, protection, compatibility, design, portability/gifting
- Work in remaining Single Words that didn't fit in the title
- Still must be readable and relevant to actual product features
- Each bullet: ~200-350 chars

**Counters & Tracking (built into the sheet):**
- Title character count (vs Amazon max)
- Title word count
- Each bullet's character count
- Total bullet characters
- **Keyword Coverage section:** Total Single Words, Used in Title, Used in Bullets Only, Used Anywhere, NOT Used (with percentages)
- **Top Unused Words:** Quick-reference list of highest-count unused words
- **Full Word Usage Detail table:** Every Single Word with columns: Word, Count, In Title? (Yes/No), In Bullets? (Yes/No)
  - Green row = used in title
  - Yellow row = used in bullets only
  - Red row = unused
  - Yes/No cells: green background for Yes, red for No
- **Notes column for unused words** explaining why each is unused:
  - "Variant X already in listing" — e.g. "boxes" when "box" is present, "sleeves" when "sleeved" is used
  - "Franchise/set name" — lorwyn, avatar, spiderman, etc.
  - "Competitor brand" — shouldn't be in our listing
  - "Color" — listing covers multiple variants
  - "Material not applicable" — doesn't describe our product
  - "Low priority / niche term" — catch-all for rare terms
  - Feature-specific flags — "check if product has this feature" (e.g. dice tray, window)

**Formatting:**
- Dark blue section headers with white bold text
- Light blue for title, light green for bullets, light yellow for stats
- Orange for top unused quick-reference
- Dark red separator for unused words section
- Column B wide (800px) with text wrap for bullet readability
- Column E (Notes) at 400px

#### Sheet: PPC Setup
- Complete PPC campaign setup ready for implementation
- **Sections:**
  1. **Campaign Structure** — overview table showing both campaigns, their match types, targeting, negatives, and goals
  2. **EXACT Campaign Keywords** — all Master List keywords sorted by search volume, with suggested PPC bids (min/max/suggested)
  3. **BROAD Campaign Keywords** — same keywords as EXACT (reference note)
  4. **BROAD Campaign — Exact Negative Keywords** — all Master List keywords as exact negatives (to avoid overlap with EXACT campaign)
  5. **BROAD Campaign — Phrase Negative Keywords** — all Never Keywords as phrase negatives (to block irrelevant search terms)
  6. **Summary** — total counts for each section + bid statistics (avg/min/max)
- **Formatting:**
  - Dark blue section headers
  - Green alternating rows for EXACT keywords
  - Purple for BROAD campaign references
  - Orange alternating rows for exact negatives
  - Red alternating rows for phrase negatives
  - Yellow for summary stats

### 4. Color Coding
- Assign each root keyword a distinct **pastel** color (HSV: saturation ~0.25, value 1.0)
- Apply the color to the root keyword's row in the Root Keywords sheet
- Apply the same color to all rows in Filtered Keywords that belong to that root keyword
- If a keyword belongs to multiple root keywords, assign it to one (most specific) and color accordingly

### 5. Upload to Google Drive
- Create as a Google Sheet (not xlsx) directly via API
- Place in the appropriate product folder (e.g., `Brands / [Brand] / Product line - [Product] /`)
- Name format: "Keyword research - [Product name]"
- Match parent folder permissions when sharing

### 6. Sheet Formatting
- **Freeze row 1 and column A** on all sheets (for easy scrolling)
- **Add filters** on all columns of every sheet
- **Numbers must be numbers** — use `valueInputOption='USER_ENTERED'` when writing to Google Sheets so numeric values are treated as numbers, not text. Never write numbers as strings (no leading apostrophe). This enables proper sorting/filtering.
- These are standard — apply to every workbook, every time

## Quality Checks
- [ ] Filtered Keywords only contains relevant keywords (≥30% of competitors ranking)
- [ ] Raw Data contains the full unfiltered Cerebro dump
- [ ] Root keywords are specific to the product, not generic category terms
- [ ] Top 5 Variants for each root keyword are all relevant to the actual product
- [ ] No "other" catch-all bucket — unclassified keywords stay blank/uncolored
- [ ] Colors are applied consistently between Root Keywords and Filtered Keywords
- [ ] Sheet is in the correct Drive folder with proper permissions

---
> **Core skill** (read-only, updated by the platform).
> If you need to add customer-specific knowledge, IDs, preferences, or learnings for this skill,
> create an extension at `workspace/skills/amazon-kw-research/SKILL.md` — do not modify this file.
