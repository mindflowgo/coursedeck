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
updatedAt: '2026-10-06'
---

course: CLU3M.4.2

# Lesson 4.2: Identifying torts

## Questions

01) [Knowledge & Understanding] Which of the following correctly lists the four legal components a plaintiff must prove in a negligence lawsuit?
<Multiple-Choice>
- [ ] Duty of care, consent, breach of duty, and vicarious liability
- [ ] Duty of care, breach of the standard of care, causation, and damages
- [ ] Standard of care, an intentional act, causation, and monetary loss
- [ ] Duty of care, the neighbour principle, absolute privilege, and damages

--

02) [Knowledge & Understanding] Which situation best illustrates **vicarious liability**?
<Multiple-Choice>
- [ ] A driver who causes an accident while impaired by alcohol
- [ ] A restaurant that serves an intoxicated patron who later injures a third party by driving
- [ ] An employer held legally responsible for the negligence of an employee committed during the employee's regular duties
- [ ] A landlord who posts a "No Trespassing" sign on private property

--

03) [Thinking & Investigation] In _Childs v. Desormeaux_, the Supreme Court of Canada decided that social hosts generally do **not** owe a legal duty of care to third parties injured by their intoxicated guests. What was the court's key reasoning for treating commercial hosts (bars, restaurants) differently?
<Multiple-Choice>
- [ ] Commercial hosts are criminally liable for all injuries caused by their patrons
- [ ] Commercial hosts profit from selling alcohol and are expected to monitor patrons' intake and ensure they can get home safely, whereas social guests are autonomous and make their own decisions
- [ ] Social hosts are automatically vicariously liable because they own the property
- [ ] Commercial hosts are protected by absolute privilege, so no duty of care can ever be established

--

04) [Communication] A radio host makes an untrue **spoken** statement on air that damages a local business owner's reputation. How should this defamation most accurately be classified?
<Multiple-Choice>
- [ ] Libel, because the statement was broadcast publicly
- [ ] Fair comment, because the host was expressing an opinion
- [ ] Slander, because the inaccurate statement was spoken (Spoken = Slander)
- [ ] Invasion of privacy, because the statement was made without consent

--

05) [Application] Allan leaves power tools, saws, and sharp objects on his front lawn overnight. A 10-year-old neighbour rides by, investigates the equipment, and slices his hand on a saw. Applying the concept of the "reasonable person," which legal component does Allan's conduct most directly fail?
<Multiple-Choice>
- [ ] Duty of care, because no relationship could ever exist between Allan and a stranger
- [ ] Breach of the standard of care, because a reasonable person would have safely stored the tools rather than leaving them accessible to others
- [ ] Causation, because the boy's injury was unavoidable
- [ ] Damages, because the boy did not require medical treatment

--

06) [Application] Maria slips on an icy sidewalk outside a store and sues the owner for negligence. The store owner's counsel argues that Maria was texting on her phone and not watching where she was walking at the time of the fall. Which defence is the store owner's counsel relying on?
<Multiple-Choice>
- [ ] Statute of limitations
- [ ] Voluntary assumption of risk
- [ ] Contributory negligence
- [ ] Absolute privilege

--

## Answers

01) **B** - (explanation) The four legal components the plaintiff must prove in a negligence case are: (1) **duty of care** (often established through a statutory duty of care or the neighbour principle), (2) **breach of the standard of care** (comparing the defendant's actions to the "reasonable person" or another applicable standard), (3) **causation** (proven through the "But for" test), and (4) **damages** (actual harm or injury must have resulted). If the plaintiff fails to prove any one of these elements, they will lose the case. Options A and C include terms like "consent," "intentional act," and "vicarious liability," which are not among the four core negligence elements.

02) **C** - (explanation) Vicarious liability means that one individual or entity is legally responsible for someone else's actions. The lesson gives three key examples: a car owner is vicariously liable for damages caused by anyone driving the car with consent; employers are vicariously liable for employee actions committed during regular duties; and in Ontario, parents may be vicariously liable for their children's actions if the children are under 18 and live at home. Option C matches the employer example. Option A describes a directly negligent driver; Option B involves a commercial host's own duty of care (as in _Childs v. Desormeaux_); Option D relates to trespass to land, not vicarious liability.

03) **B** - (explanation) In _Childs v. Desormeaux_ (2006), the Supreme Court of Canada held that social hosts generally do not owe a duty of care to third parties injured by drunk guests. The court reasoned that commercial hosts (bars and restaurants) differ because they sell alcohol for profit, have an incentive to serve, are expected to monitor how much patrons drink, and must help ensure patrons get home safely. Social hosts, by contrast, do not monitor their guests' intake, and their guests are autonomous and make their own decisions. Options A and D misstate the law, and Option C confuses vicarious liability (which is not the basis of the court's distinction here).

04) **C** - (explanation) Defamation has two main types: **libel** (permanent, written form such as letters, newspapers, magazines, and websites) and **slander** (verbal communications using spoken words, sounds, or gestures). The lesson's memory trick is "Slander - S - Spoken; Libel - L - Literature." Because the radio host's damaging statement was spoken, it is slander. Libel would require a written or otherwise permanent form. Fair comment requires an honest opinion without malice about public figures or issues, and invasion of privacy is a separate tort recognized in _Jones v. Tsige_ (2012), neither of which applies here.

05) **B** - (explanation) The second legal component of negligence is the applicable **standard of care**, usually "the reasonable person." The plaintiff must then prove the defendant **breached** that standard — that is, the defendant acted in a manner an ordinary, reasonable person would not have. The reasonable person would have put dangerous tools away or covered them so others could not access them. Since Allan left sharp equipment accessible and his behaviour does not match that of the reasonable person, he breached his duty of care (Option B is correct). A duty of care **does** exist (the neighbour principle applies to foreseeable harm to strangers), so Option A is wrong. Causation is a separate component, and damages clearly resulted, making Options C and D incorrect.

06) **C** - (explanation) **Contributory negligence** is a defence that applies when the plaintiff did something (or failed to do something) that contributed to their own damages. When this occurs, the judge can find both parties liable to some degree and split the damages proportionally — as seen in _Crocker v. Sundance Northwest Resorts Ltd._ (where the plaintiff was found 25% responsible and the resort 75% responsible). Here, the store owner claims Maria contributed to her own injury by texting instead of watching where she was walking. The **statute of limitations** involves missing the two-year filing deadline under Ontario's _Limitations Act_; **voluntary assumption of risk** requires the plaintiff to have knowingly accepted the risk (common in skydiving or hockey); and **absolute privilege** protects statements made in legislative or judicial proceedings — none of which fit this scenario.

--

## Fill-in-the-Blank

1. The **neighbour principle** states that every individual owes a legal duty of care to anyone they can ________ foresee could be injured or harmed by their actions.

2. In Ontario, the _Limitations Act_ requires that most negligence lawsuits be started within ________ years of the plaintiff becoming aware (or when a reasonable person should have become aware) of the claim's elements of negligence.

3. ________ negligence occurs when the plaintiff's own actions contributed to their damages, allowing a judge to split responsibility between the parties in any proportion.

4. ________ liability makes an individual or entity (such as an employer, car owner, or parent) legally responsible for the negligence of another person committed during the course of their duties.

--

## Fill-in-the-Blank Answers

1. **reasonably** — The neighbour principle, established in _Donaghue v. Stevenson_ (1932), holds that a person owes a duty of care to anyone they can reasonably foresee might be injured by their actions, even complete strangers.

2. **two (2)** — The _Ontario Limitations Act_ requires most negligence claims to be filed within two years of the plaintiff becoming aware, or when they should reasonably have become aware, of the elements of negligence. Defendants can ask the court to dismiss cases filed after this period.

3. **Contributory** — In contributory negligence, both the defendant and plaintiff are liable to some degree for the harm; the judge may divide damages proportionally (e.g., _Crocker v. Sundance Northwest Resorts Ltd._, where the plaintiff was 25% at fault).

4. **Vicarious** — Vicarious liability makes one party responsible for another's negligence; examples include an employer for employee actions during regular duties, a car owner for a consented driver, and (in Ontario) parents for their children under 18 who live at home.
