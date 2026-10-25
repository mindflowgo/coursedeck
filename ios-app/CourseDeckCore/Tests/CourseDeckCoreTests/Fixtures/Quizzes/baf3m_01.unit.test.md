---
prompt: |
  # Unit Practice Test

  You are an expert Ontario Secondary School curriculum evaluator.
  Create a comprehensive unit-wide practice test covering all lessons within this unit, strictly aligned with the Ontario Curriculum Achievement Chart (KICA). For the multiple choice be sure to vary the correct answer so it is not the same letter.

  ## Requirements:
  1. Generate **8 Multiple Choice Questions** covering key concepts across the unit lessons (numbered 01 to 08):
     - 2 Knowledge & Understanding (KU)
     - 2 Thinking & Investigation (TI)
     - 2 Communication (C)
     - 2 Application (A)
     Each multiple choice question must have exactly 4 options labeled A, B, C, D using markdown checkbox lists (`- [ ]`).

  2. Generate **2 Fill-in-the-Blank Questions** integrating concepts from multiple lessons in the unit (numbered 09 and 10):
     - Tag with `[Fill-in-the-Blank]` category.
     - Question must contain a blank represented by `_______`.

  3. Generate **2 Short-Answer / Problem-Solving Questions** integrating concepts from multiple lessons in the unit (numbered 11 and 12):
     - Open-ended problem-solving or conceptual synthesis requiring a multi-sentence response or step-by-step reasoning.

  4. Number all questions sequentially from 01 to 12 across all sections.

  5. Provide a complete Answer Key under `## Answers & Explanations` for all 12 questions with concise explanations and grading criteria.

  ## Output Schema:
  # Unit Practice Exam

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

  ... (questions 03 to 08 for Multiple Choice)

  --

  09) [Fill-in-the-Blank] <Sentence containing a _______ blank testing key idea>

  --

  10) [Fill-in-the-Blank] <Sentence containing a _______ blank testing key idea>

  --

  ## Short Answer / Application Problems
  11) [Application] <Problem prompt testing synthesis of unit lessons>

  --

  12) [Problem-Solving] <Problem prompt testing synthesis of unit lessons>

  --

  ## Answers & Explanations
  01) B - (explanation) <Detailed rationale explaining why B is correct and citing specific lesson concepts>.
  02) A - (explanation) <Detailed rationale explaining why A is correct and citing specific lesson concepts>.
  ...
  09) [Target Word or Phrase] - (explanation) <Brief explanation citing lesson concepts>.
  10) [Target Word or Phrase] - (explanation) <Brief explanation citing lesson concepts>.
  11) <Expected Criteria / Rubric> - (explanation) <Detailed rationale and key points the student must articulate>.
  12) <Expected Criteria / Rubric> - (explanation) <Detailed rationale and key points the student must articulate>.
type: test
updatedAt: '2026-10-22'
contextAttachment: unit - lessons
lastAttemptDate: '2026-10-22'
score: 1.25
totalQuestions: 12
percentage: 10
---

# Unit Practice Exam

## Questions
01) [Knowledge & Understanding] Which statement best defines **owner’s equity**?
- [ ] A) The total value of all items owned by a business
- [ ] B) The difference between total assets and total liabilities
- [ ] C) The total amount owed to creditors by a business
- [ ] D) The total revenue earned minus total expenses for a period

--

02) [Knowledge & Understanding] Which form of business organization is a **separate legal entity**, pays its own income tax, and gives its owners **limited liability**?
- [ ] A) Sole proprietorship
- [ ] B) General partnership
- [ ] C) Limited partnership
- [ ] D) Corporation

--

03) [Thinking & Investigation] A business reports total assets of **$85,000** and total liabilities of **$37,000**. What is the owner’s equity, and what does it represent?
- [ ] A) $48,000; the owner’s claim on the assets after creditor claims are paid
- [ ] B) $122,000; the total resources controlled by the business
- [ ] C) $37,000; the amount the business owes to creditors
- [ ] D) $48,000; the net income earned during the accounting period

--

04) [Thinking & Investigation] A business owner records a family vacation as a **business travel expense**. Which accounting principle is being violated?
- [ ] A) Matching principle
- [ ] B) Consistency principle
- [ ] C) Business entity principle
- [ ] D) Full disclosure principle

--

05) [Communication] Which statement best explains why accounting standards such as **IFRS** and **ASPE** are important to users of financial statements?
- [ ] A) They guarantee that every business will earn a profit.
- [ ] B) They eliminate the need for auditors or accountants.
- [ ] C) They allow each business to choose any recording method it prefers.
- [ ] D) They make financial information more comparable and reliable for decision-making.

--

06) [Communication] A student says, “Bookkeeping and accounting are the same thing.” Which response best clarifies the difference?
- [ ] A) Bookkeeping is only for tax purposes, while accounting is only for banks.
- [ ] B) Bookkeeping records transactions; accounting also summarizes, analyzes, and interprets information for decisions.
- [ ] C) Accounting is only done manually, while bookkeeping is only done with computers.
- [ ] D) Bookkeeping includes auditing, while accounting is limited to journal entries.

--

07) [Application] Clara has total assets of **$60,000** and total liabilities of **$22,000**. She is applying for a business loan. Using the fundamental accounting equation, what is her owner’s equity and how would a bank most likely view it?
- [ ] A) $82,000; strong because assets exceed liabilities
- [ ] B) $22,000; weak because liabilities are low
- [ ] C) $38,000; positive equity, which suggests a stronger ability to repay debt
- [ ] D) $60,000; the bank only considers total assets, not liabilities

--

08) [Application] A partnership is worried about **unlimited liability** for all its partners. Which option best addresses this concern while keeping a partnership structure?
- [ ] A) Form a limited partnership with general partners and limited partners.
- [ ] B) Convert into a sole proprietorship.
- [ ] C) Avoid recording liabilities in the accounting records.
- [ ] D) Hire more employees to reduce the partners’ responsibility.

--

09) [Fill-in-the-Blank] The fundamental accounting equation is **Assets − Liabilities = _______**, which represents the owner’s claim on the business after all creditor claims are paid.

--

10) [Fill-in-the-Blank] Canadian accounting professionals are unified under the **_______ designation**, and they must follow a code of professional conduct that emphasizes ethical behaviour and public trust.

--

## Short Answer / Application Problems
11) [Application] Maya operates a **sole proprietorship** with total assets of **$95,000** and total liabilities of **$40,000**. She wants to expand, hire employees, and computerize her accounting system.  
a) Calculate Maya’s owner’s equity using the fundamental accounting equation.  
b) Explain what this equity value represents.  
c) Identify **two risks** of remaining a sole proprietorship.  
d) Recommend **one form of business ownership** and **one technology strategy** that would help Maya manage growth. Justify your recommendations using concepts from the unit.

--

12) [Problem-Solving] You are the accountant for a private corporation. The owner asks you to record personal home renovations as **business expenses** to reduce taxable income. The owner also wants you to omit a pending lawsuit from the financial statements because it might worry the bank.  
Identify **two accounting principles or ethical standards** that are being violated. Explain how this action could affect at least **two users** of the financial statements. Finally, describe what steps you should take as an ethical accountant according to the **CPA Code of Professional Conduct**.

--

## Answers & Explanations
01) B - Owner’s equity is the difference between total assets and total liabilities. In Lesson 1.1, the fundamental accounting equation is taught as **Assets − Liabilities = Owner’s Equity**, representing the owner’s remaining claim after creditors are paid.

02) D - A corporation is a separate legal entity, pays its own income tax, and provides shareholders with limited liability. Lesson 1.2 explains that corporations have advantages such as limited liability, transferable ownership, and unlimited life, though they also face double taxation and heavier regulation.

03) A - Using the fundamental accounting equation: **$85,000 − $37,000 = $48,000**. Owner’s equity represents the owner’s claim on the business assets after all creditor claims are paid. Options B, C, and D misidentify the amount or the meaning of equity.

04) C - The business entity principle states that business records must be kept separate from the owner’s personal financial records. Recording a family vacation as a business expense mixes personal and business transactions, violating this principle from Lesson 1.5.

05) D - Accounting standards such as IFRS and ASPE provide consistent rules so that financial statements are comparable and reliable. Lesson 1.1 explains that users such as owners, managers, creditors, investors, and government rely on accounting information to make informed decisions.

06) B - Bookkeeping is the first part of the accounting process: recording transactions in journals and ledgers. Accounting is broader; it includes recording, controlling, analyzing, and interpreting information for decision-making, as explained in Lesson 1.1.

07) C - Using the equation: **$60,000 − $22,000 = $38,000**. Positive equity means the owner has a claim on assets after liabilities are considered. A bank would likely see positive equity as a favourable sign, although it would also consider credit history, payment patterns, and the purpose of the loan.

08) A - A limited partnership includes general partners, who have unlimited liability, and limited partners, whose liability is limited to their investment. Lesson 1.2 explains that this structure helps address the unlimited liability problem of a general partnership.

09) Owner’s equity (also accepted: equity, net worth, capital) - The fundamental accounting equation from Lesson 1.1 is **Assets − Liabilities = Owner’s Equity**. It shows the owner’s claim on the business after creditors are paid.

10) CPA (Chartered Professional Accountant) - Lesson 1.4 explains that Canadian accounting designations were unified under the CPA designation. Lesson 1.5 explains that CPAs follow a professional code of conduct emphasizing ethics, integrity, objectivity, and public trust.

11) Expected Criteria / Rubric -  
- **Calculation (1 mark):** Owner’s equity = **$95,000 − $40,000 = $55,000**.  
- **Interpretation (1 mark):** The $55,000 represents Maya’s claim on the assets after creditors are paid; it is her financial net worth in the business.  
- **Risks (2 marks):** Accept any two: unlimited personal liability, limited capital, lack of continuity, personal responsibility, difficulty raising large amounts of financing.  
- **Recommendation (2 marks):** A strong answer may recommend incorporating because a corporation provides limited liability, transferable ownership, unlimited life, and greater access to capital. A limited partnership could also be accepted if justified.  
- **Technology strategy (2 marks):** Recommend computerized accounting software because it saves time, provides instant reports, improves access to information, and creates an audit trail. Note disadvantages such as cost, training needs, security risks, and backup requirements.  
- **Communication (1 mark):** Clear, organized response using correct accounting terminology.

12) Expected Criteria / Rubric -  
- **Principles/standards violated (2 marks):** Accept any two: **business entity principle** because personal renovations are being mixed with business records; **full disclosure principle** and/or **materiality** because the lawsuit should be disclosed if it could affect users’ decisions; **objectivity principle** because records should be based on accurate source documents; ethical principles such as integrity and professional behaviour.  
- **Impact on users (2 marks):** Creditors/bank may make lending decisions based on misleading financial statements; government/CRA may lose tax revenue due to false expense claims; investors/shareholders may be misled about the corporation’s true financial position; owners/managers may make poor decisions based on inaccurate records.  
- **Ethical accountant’s steps (3 marks):** Refuse to record false or misleading entries; explain the violation of accounting principles and the CPA Code; advise the owner to correct the records and disclose the lawsuit; document the concern; consult professional standards or a supervisor; consider withdrawing from the engagement or reporting further if the owner insists.  
- **Communication (1 mark):** Professional tone, clear reasoning, and accurate use of accounting and ethics terminology.
