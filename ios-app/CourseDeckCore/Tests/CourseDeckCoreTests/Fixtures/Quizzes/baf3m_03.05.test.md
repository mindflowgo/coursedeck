---
prompt: |
  # KICA Practice Test Generation Prompt

  You are an expert Ontario Secondary School curriculum evaluator.
  Create an interactive practice quiz for the provided lesson based on the Ontario Curriculum Achievement Chart (KICA).

  Generate 6 multiple choice questions strictly following the standardized question schema below:
  - Include questions spanning:
    1. Knowledge & Understanding (KU)
    2. Thinking & Investigation (TI)
    3. Communication (C)
    4. Application (A)

  Then generate 4 fill-in-the-blank questions covering the top ideas needing covering.

  ## Output Schema (Multiple Choice):
  course: <COURSE_ID>.<UNIT>.<LESSON>

  # Lesson <LESSON_NUM>: <TITLE>

  ## Questions
  01) [Knowledge & Understanding] <Question prompt>
  <Multiple-Choice>
  - [ ] <Option A>
  - [ ] <Option B>
  - [ ] <Option C>
  - [ ] <Option D>

  --

  02) [Thinking & Investigation] <Question prompt>
  <Multiple-Choice>
  - [ ] <Option A>
  - [ ] <Option B>
  - [ ] <Option C>
  - [ ] <Option D>

  --

  ## Answers
  01) B - (explanation) <Detailed rationale explaining why B is correct and citing specific lesson concepts>.
  02) A - (explanation) <Detailed rationale explaining why A is correct and citing specific lesson concepts>.
type: test
version: 1
updatedAt: '2026-10-05'
---

course: baf3m.3.5

# Lesson 5: Completing the accounting cycle for a merchandising business

## Questions

01) [Knowledge & Understanding] Which item is added to Purchases when preparing a schedule of cost of goods sold under the periodic inventory system?
<Multiple-Choice>
- [ ] Purchases Returns and Allowances
- [ ] Purchases Discounts
- [ ] Transportation on Purchases
- [ ] Ending Merchandise Inventory

--

02) [Knowledge & Understanding] In completing the accounting cycle for a merchandising business using periodic inventory, which supporting statement/financial statement is prepared first?
<Multiple-Choice>
- [ ] Classified balance sheet
- [ ] Classified income statement
- [ ] Schedule of cost of goods sold
- [ ] Post-closing trial balance

--

03) [Thinking & Investigation] Darwin Discount Stores has beginning merchandise inventory $50,000, purchases $86,000, transportation on purchases $4,900, purchases returns and allowances $6,000, purchases discounts $1,800, and ending merchandise inventory $52,000. What is cost of goods sold?
<Multiple-Choice>
- [ ] $81,100
- [ ] $78,200
- [ ] $83,100
- [ ] $133,100

--

04) [Communication] Carter Enterprises reports net income of $2,247 and drawings of $5,000. Capital was $91,865 on January 1 and $89,112 on December 31. What does this communicate to a user of the financial statements?
<Multiple-Choice>
- [ ] The business had a net loss of $2,753.
- [ ] Drawings were greater than net income, so owner's equity decreased.
- [ ] The balance sheet does not balance because capital decreased.
- [ ] Net income was closed directly to Drawings.

--

05) [Application] For Carter Enterprises, which journal entry correctly records closing Step 1: closing the revenue account and recording ending merchandise inventory of $61,000?
<Multiple-Choice>
- [ ] Dr Sales $130,000; Dr Merchandise Inventory $61,000; Cr Income Summary $191,000
- [ ] Dr Income Summary $191,000; Cr Sales $130,000; Cr Merchandise Inventory $61,000
- [ ] Dr Sales $130,000; Cr Merchandise Inventory $61,000; Cr Income Summary $69,000
- [ ] Dr Income Summary $191,000; Dr Sales $130,000; Cr Merchandise Inventory $61,000

--

06) [Application] Which account would not appear on Carter Enterprises' post-closing trial balance?
<Multiple-Choice>
- [ ] Sales
- [ ] Merchandise Inventory
- [ ] T. Carter, Capital
- [ ] Accounts Payable

--

## Fill-in-the-Blank Questions

1. The first statement prepared at the end of the period for a merchandising business using the periodic inventory system is the ______________________.
2. In the closing process, revenue, expense, and cost of goods sold accounts are closed into the ______________________ account.
3. The classified income statement separates operating expenses into ______________________ expenses and ______________________ expenses.
4. After the closing entries are posted, a ______________________ is prepared to prove that total debits still equal total credits.

## Answers

01) C - Transportation on Purchases is added to Purchases on the schedule of cost of goods sold. Purchases Returns and Allowances and Purchases Discounts are deducted, and ending Merchandise Inventory is deducted after calculating cost of merchandise available.
02) C - The schedule of cost of goods sold is the first supporting statement prepared. Its result is needed before the classified income statement can show gross profit.
03) A - Net purchases = $86,000 - $6,000 - $1,800 = $78,200. Add transportation on purchases = $83,100. Add beginning inventory = $133,100. Less ending inventory $52,000 = $81,100 COGS.
04) B - Net income increases owner's equity, while drawings decrease it. Here, drawings ($5,000) exceeded net income ($2,247), producing a $2,753 decrease in capital: $91,865 + $2,247 - $5,000 = $89,112.
05) A - Step 1 closes the credit-balance revenue section and records ending inventory: debit Sales $130,000, debit Merchandise Inventory $61,000, and credit Income Summary $191,000.
06) A - Sales is a temporary revenue account. It is closed to Income Summary, so it has a zero balance and does not appear on the post-closing trial balance. Only permanent accounts such as Merchandise Inventory, Capital, and Accounts Payable remain.

### Fill-in-the-Blank Answers
1. schedule of cost of goods sold
2. Income Summary
3. administrative; selling
4. post-closing trial balance
