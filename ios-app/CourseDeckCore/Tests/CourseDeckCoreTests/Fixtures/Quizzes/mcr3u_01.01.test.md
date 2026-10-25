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

course: MCR3U.Unit 1: Foundations.1.1 Introducing functions

# Lesson 1.1: Introducing functions

## Questions

01) [Knowledge & Understanding] Which statement best defines a function?
<Multiple-Choice>
- [ ] A relation in which each y-value corresponds to exactly one x-value.
- [ ] A relation in which each x-value corresponds to exactly one y-value.
- [ ] Any relation that can be shown as a table of values.
- [ ] Any relation whose graph is a straight line.
</Multiple-Choice>

--

02) [Thinking & Investigation] A mapping diagram has left-side values 5, 1, -3, -7 and right-side values 2, 3, 7, 9. The arrows are: 5→2, 5→9, 1→3, -3→7, and -7→9. Which statement is correct?
<Multiple-Choice>
- [ ] It is a function because every y-value has at least one arrow pointing to it.
- [ ] It is not a function because x = 5 maps to two different y-values, 2 and 9.
- [ ] It is a function because no y-value is repeated.
- [ ] It is not a function because y = 9 is mapped from both 5 and -7.
</Multiple-Choice>

--

03) [Communication] For the function f(x) = 40x + 20, what does f(3) = 140 mean?
<Multiple-Choice>
- [ ] The point (140, 3) is on the graph of f.
- [ ] When the input is x = 3, the output is y = 140, so (3, 140) is on the graph.
- [ ] The domain value 140 produces the range value 3.
- [ ] f(x) = 3 when x = 140.
</Multiple-Choice>

--

04) [Application] TJ’s Garage charges a base fee of $20 plus $40 for each hour of labour. If x represents hours of labour and y represents total cost, which domain is appropriate for this real-world function?
<Multiple-Choice>
- [ ] D = {x ∈ R | x ≥ 0}
- [ ] D = {x ∈ R | x ≥ 20}
- [ ] D = {x ∈ R | 0 ≤ x ≤ 40}
- [ ] D = {x ∈ R | x ≤ 0}
</Multiple-Choice>

--

05) [Thinking & Investigation] Mina recorded ages and heights: ages 15, 15, 16, 17, 17, 18, 20 with corresponding heights 152, 185, 155, 170, 173, 185, 161. Which statement is correct?
<Multiple-Choice>
- [ ] It is a function because every age has a height listed.
- [ ] It is not a function because ages 15 and 17 each correspond to more than one height.
- [ ] It is a function because the height 185 cm repeats.
- [ ] It is not a function because repeated heights occur in the height list.
</Multiple-Choice>

--

06) [Application] Which equation represents a relation that is NOT a function?
<Multiple-Choice>
- [ ] y = 4x + 3
- [ ] y = 2(x - 1)^2 + 5
- [ ] 625 = x^2 + y^2
- [ ] y = -5(x - 3)(x + 4)
</Multiple-Choice>

--

## Answers

01) B - A function is defined as a relation where each value of the independent variable x corresponds to only one value of the dependent variable y. Repeated y-values are allowed, but repeated x-values are not.

02) B - In the mapping diagram, x = 5 maps to both 2 and 9. Since one x-value corresponds to two different y-values, the relation is not a function. The fact that y = 9 is mapped from both 5 and -7 is allowed because repeated y-values are okay.

03) B - Function notation f(3) = 140 means that when the independent variable is x = 3, the dependent variable is y = 140. Therefore, the point (3, 140) lies on the graph of f(x) = 40x + 20.

04) A - The number of hours of labour cannot be negative, so x ≥ 0. There is no stated maximum number of hours, so the domain is D = {x ∈ R | x ≥ 0}. The range would be y ≥ 20 because the minimum total cost is the $20 base fee.

05) B - The relation is not a function because the age 15 corresponds to two heights, 152 and 185, and the age 17 corresponds to two heights, 170 and 173. A function cannot have a repeated x-value mapping to different y-values.

06) C - The equation 625 = x^2 + y^2 is a circle with radius 25 centred at the origin. A circle is not a function because it fails the vertical line test. The other equations are linear or quadratic functions.

## Fill-in-the-Blank Questions

01) A ______ is an expression that demonstrates the connection between an independent variable x and a dependent variable y.

02) A relation is a function if each value of the independent variable x corresponds to exactly ______ value of the dependent variable y; a graph fails to be a function if it fails the ______ test.

03) The set of all possible values of the independent variable is called the ______, and the set of all possible values of the dependent variable is called the ______.

04) If y = 40x + 20, then using function notation this is written as ______.

## Fill-in-the-Blank Answers

01) relation

02) one; vertical-line

03) domain; range

04) f(x) = 40x + 20
