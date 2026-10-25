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

course: GWL3O.Unit2.2.1

# Lesson 2.1: Communication skills and interpersonal intelligence

## Questions

01) [Knowledge & Understanding] Julian Treasure advises communicators to remember the acronym "HAIL". Which of the following correctly matches the letter to its meaning?
<Multiple-Choice>
- [ ] H – Helpfulness: offering solutions to your listener's problems before they ask for them
- [ ] A – Assertiveness: taking control of the conversation so your message is heard
- [ ] I – Integrity: being your word, actually doing what you say, and being somebody people can trust
- [ ] L – Listening: waiting quietly until the other person has finished speaking

--

02) [Knowledge & Understanding] Which statement best defines **emotional intelligence** as it is described in this lesson?
<Multiple-Choice>
- [ ] The ability to score highly on a standard IQ test and apply that score to workplace tasks
- [ ] The ability to perceive, assess, and manage your own emotions, those of others, and those of groups
- [ ] The natural, inherited talent for music, movement, or numbers that cannot be changed or developed
- [ ] The ability to hear sounds accurately and retain written information for later use

--

03) [Thinking & Investigation] During a job interview, the interviewer asks Jayden, "How do you react to conflict?" Jayden is not certain whether the question is about disagreements between co-workers or about handling difficult customers. According to the lesson, what is the **best** course of action?
<Multiple-Choice>
- [ ] Give a broad, general answer that could apply to many situations so he does not appear unsure
- [ ] Ask the interviewer to clarify — for example, "Are you asking about disagreements between co-workers or about handling difficult customers?"
- [ ] Stay silent and wait for the interviewer to rephrase the question on their own
- [ ] Answer only about co-workers, since that is the most likely meaning of the question

--

04) [Communication] According to the lesson, which combination of behaviours best shows a speaker that you are **actively listening** rather than merely hearing?
<Multiple-Choice>
- [ ] Keeping your eyes on your notes, writing down every word, and saving your questions for the end
- [ ] Nodding and smiling while planning your reply, then interrupting to correct small details
- [ ] Maintaining eye contact, not interrupting, giving feedback, and repeating the message in your own words for clarification
- [ ] Staying completely still and silent so the speaker is not distracted by any reaction

--

05) [Application] Priya works at a busy customer service desk. Before a frustrated customer even explains the problem, Priya senses the customer's emotion, adjusts her tone, and calmly helps them find a solution. Which of the seven intelligences from the lesson is Priya most clearly demonstrating?
<Multiple-Choice>
- [ ] Logical/Mathematical intelligence, because she is solving a problem quickly and efficiently
- [ ] Spatial intelligence, because she can picture how the customer's issue fits together
- [ ] Emotional/interpersonal intelligence, because she perceives others' feelings and relates well to them
- [ ] Musical intelligence, because she adjusts the rhythm and tone of her speech

--

06) [Application] Morgan completed a multiple intelligences assessment and scored highest in **Linguistic** and **Interpersonal** intelligence. Which job best combines Morgan's two strongest intelligence types in the workplace?
<Multiple-Choice>
- [ ] Forensic accountant, working mainly with numbers, calculations, and independent analysis
- [ ] Broadcast journalist, who uses language skill and relates well to interview subjects and audiences
- [ ] Set designer, who visualizes how objects look and fit together in a physical space
- [ ] Track-and-field athlete, who relies on agility, balance, and control of movement

--

## Answers

01) C – (explanation) The lesson presents Julian Treasure's HAIL acronym directly: **H** is honesty (being true and clear in what you say), **A** is authenticity (just being yourself), **I** is integrity (being your word, doing what you say, and being someone people can trust), and **L** is love (wishing people well). Only option C matches the lesson's definition. Option A invents "helpfulness," option B confuses authenticity/assertiveness, and option D confuses the "L" — love — with listening, which is a communication skill, not part of the acronym.

02) B – (explanation) The lesson defines emotional intelligence (popularized by Daniel Goleman) as "the ability or skill to perceive, assess, and manage your own emotions, those of others, and those of groups." It also notes that emotional intelligence expands on interpersonal and intrapersonal intelligence and is **learnable**, which rules out option C (the claim that intelligence is fixed and inherited). Option A confuses emotional intelligence with IQ score, and option D describes hearing and reading retention, not emotional intelligence.

03) B – (explanation) The lesson identifies "repeat questions or statements in your own words for clarification" as a key listening strategy and gives this exact interview example: replying "Are you asking about disagreements between co-workers or about handling difficult customers?" Asking for clarification "indicates that you are listening carefully and that you want to be precise in answering the questions." Option A risks answering the wrong question, option C abandons the communication process rather than actively participating in it, and option D prejudges the question — the opposite of "listen with an open mind."

04) C – (explanation) The lesson distinguishes hearing (passively sensing sounds) from listening (actively participating by receiving and retaining information, which requires concentration and focus). Its list of ways to strengthen listening includes: listen with an open mind, do not interrupt, pay attention and show interest, take notes, give feedback to indicate you are listening, and repeat questions or statements in your own words for clarification. Option C combines several of these behaviours; option A undermines eye contact and shows no feedback to the speaker, option B describes interruption and prejudging, and option D is passive — which describes hearing, not listening.

05) C – (explanation) Emotional intelligence is described as expanding on interpersonal and intrapersonal intelligence, and it involves perceiving, assessing, and managing emotions in yourself, in others, and in groups. The lesson's "Perceiving" skill is defined as reading other people's emotions without their having to tell you what they are feeling, and people with interpersonal intelligence "relate well to others, sense what others are feeling, understand others" — exactly what Priya does. Options A, B, and D name other intelligences from the lesson's table (Logical/Mathematical, Spatial, Musical) that do not describe sensing and responding to another person's emotions.

06) B – (explanation) The lesson's table states that people with **Linguistic** intelligence "are good with language and words, spoken and written," and people with **Interpersonal** intelligence "relate well to others, can sense what others are feeling, understand others." A broadcast journalist uses language skill to communicate and interpersonal skill to connect with interviewees and an audience, making it the only option that combines both of Morgan's top intelligences. The other options draw on Logical/Mathematical (A), Spatial (C), and Bodily/Kinesthetic (D) intelligence. The lesson's Consolidation task also asks students to identify "one job that you could see combining both of these types."

--

## Fill-in-the-Blank Questions

1. Hearing is passively sensing sounds, whereas __________ is actively participating in the communication process by receiving and retaining information, and it requires concentration and focus.

2. Julian Treasure's acronym HAIL stands for Honesty, Authenticity, __________, and Love.

3. Emotional intelligence describes the ability or skill to perceive, assess, and manage your own emotions, those of __________, and those of groups.

4. People with __________ intelligence relate well to others in all areas of their life: they relate to others, sense what others are feeling, and understand others.

## Fill-in-the-Blank Answers

1. **listening** – The lesson's definition box distinguishes hearing (passive sensing of sounds) from listening (active participation in the communication process). Listening requires concentration and focus, and studies show people spend more time listening than on any other communication activity.

2. **Integrity** – The "I" in HAIL is integrity: "being your word, actually doing what you say, and being somebody people can trust." The other three cornerstones are honesty (being true, straight, and clear), authenticity (just being yourself), and love (wishing people well).

3. **others** – Goleman's emotional intelligence involves perceiving, assessing, and managing emotions in yourself, in other people, and in groups. It is described as expanding on interpersonal and intrapersonal intelligence, and Goleman believes it is learnable rather than fixed.

4. **interpersonal** – Interpersonal intelligence means you relate well to others, sense what others are feeling, and understand others. The lesson notes that these skills are similar to teamwork skills but go beyond them, making high interpersonal intelligence an asset in today's workplace.
