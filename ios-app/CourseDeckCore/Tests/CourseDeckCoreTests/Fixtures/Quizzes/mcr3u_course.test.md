---
prompt: |-
  # Final Course Practice Exam Generation Prompt

  You are an expert Ontario Secondary School curriculum evaluator.
  Create a comprehensive, cumulative final practice exam covering the provided course material across all units, strictly aligned with the Ontario Curriculum Achievement Chart (KICA).

  ## Requirements:
  1. Generate **12 Multiple Choice Questions** evenly distributed across all units:
     - 3 Knowledge & Understanding (KU)
     - 3 Thinking & Investigation (TI)
     - 3 Communication (C)
     - 3 Application (A)

  2. Generate **4 Comprehensive Multi-Part Questions**:
     - Provide scenario-based questions integrating concepts across multiple units.

  3. Follow the standardized schema for the multiple-choice section:

  ## Output Schema (Multiple Choice):
  course: <COURSE_ID> - Final Exam

  # Comprehensive Final Course Practice Exam

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

  ## Comprehensive Short Answer / Case Problems
  01) <Multi-unit problem prompt>
  02) <Multi-unit problem prompt>

  --

  ## Answers & Detailed Solutions
  01) B - (explanation) <Detailed rationale explaining why B is correct, citing the specific course unit concepts>.
  02) A - (explanation) <Detailed rationale explaining why A is correct, citing the specific course unit concepts>.
  ...
type: course_test
updatedAt: '2026-10-08'
---

course: MCR3U - Final Exam

# Comprehensive Final Course Practice Exam

## Questions
01) [Knowledge & Understanding] Which set of ordered pairs represents a function?
<Multiple-Choice>
- [ ] {(1,2), (1,3), (2,4), (3,5)}
- [ ] {(1,2), (2,2), (3,3), (4,4)}
- [ ] {(1,2), (2,3), (2,4), (3,5)}
- [ ] {(1,1), (2,2), (2,3), (3,3)}

--

02) [Thinking & Investigation] The function f(x) = (x + 3)^2 − 5 is restricted to x ≥ −3 so that its inverse is a function. What is f⁻¹(x)?
<Multiple-Choice>
- [ ] f⁻¹(x) = √(x + 5) − 3
- [ ] f⁻¹(x) = −√(x + 5) − 3
- [ ] f⁻¹(x) = √(x − 5) − 3
- [ ] f⁻¹(x) = √(x + 5) + 3

--

03) [Application] The profit P(x) = −2(x − 3)(x − 7), in hundreds of dollars, is earned from selling x hundred items. What is the maximum profit?
<Multiple-Choice>
- [ ] $400
- [ ] $800
- [ ] $1,200
- [ ] $2,000

--

04) [Knowledge & Understanding] Evaluate 81^(3/2).
<Multiple-Choice>
- [ ] 27
- [ ] 243
- [ ] 729
- [ ] 6561

--

05) [Communication] Which statement best explains how to distinguish an exponential function from a quadratic function using a table of values?
<Multiple-Choice>
- [ ] Exponential functions have constant first differences; quadratic functions have constant second differences.
- [ ] Exponential functions have a constant ratio between consecutive y-values; quadratic functions have constant second differences.
- [ ] Exponential functions have constant second differences; quadratic functions have a constant ratio between consecutive y-values.
- [ ] Both exponential and quadratic functions have constant first differences.

--

06) [Application] A car’s value is modelled by f(x) = 28000(0.83)^x, where x is the number of years since purchase. What is the car’s value at the end of 4 years, to the nearest dollar?
<Multiple-Choice>
- [ ] $13,288
- [ ] $16,800
- [ ] $19,000
- [ ] $23,240

--

07) [Knowledge & Understanding] What is the common difference of the arithmetic sequence 278, 264, 250, 236, 222, ...?
<Multiple-Choice>
- [ ] −14
- [ ] 14
- [ ] −24
- [ ] 24

--

08) [Thinking & Investigation] For the series 6 + 9 + 12 + ..., determine S₂₀.
<Multiple-Choice>
- [ ] 690
- [ ] 660
- [ ] 720
- [ ] 600

--

09) [Communication] Which sentence best communicates the connection among compound interest, exponential functions, and geometric sequences?
<Multiple-Choice>
- [ ] Compound interest grows linearly because interest is added to principal each year, so balances form an arithmetic sequence.
- [ ] Compound interest grows exponentially because each period’s amount is multiplied by a constant factor, so balances form a geometric sequence.
- [ ] Compound interest is unrelated to sequences because it depends only on the interest rate.
- [ ] Compound interest is a quadratic function because the interest compounds over time.

--

10) [Thinking & Investigation] Simplify cos x tan x.
<Multiple-Choice>
- [ ] sin x
- [ ] cos x
- [ ] 1
- [ ] cot x

--

11) [Communication] Which statement correctly describes the transformations of y = −2 sin[1/2(x − 60°)] + 3?
<Multiple-Choice>
- [ ] Reflection in the x-axis, vertical stretch by a factor of 2, horizontal stretch by a factor of 2, phase shift 60° right, vertical shift 3 units up.
- [ ] Reflection in the y-axis, vertical stretch by a factor of 2, horizontal compression by a factor of 1/2, phase shift 60° left, vertical shift 3 units up.
- [ ] Reflection in the x-axis, vertical compression by a factor of 1/2, horizontal stretch by a factor of 2, phase shift 60° left, vertical shift 3 units down.
- [ ] Reflection in the x-axis, vertical stretch by a factor of 2, horizontal compression by a factor of 2, phase shift 60° right, vertical shift 3 units up.

--

12) [Application] The average depth of water at low tide is 5 m and at high tide is 10 m. One complete tide cycle takes 12 hours. If high tide is at midnight (t = 0), which cosine equation models the tide height h(t) in metres after t hours?
<Multiple-Choice>
- [ ] h(t) = 2.5 cos(30t) + 7.5
- [ ] h(t) = 7.5 cos(30t) + 2.5
- [ ] h(t) = 2.5 cos(12t) + 7.5
- [ ] h(t) = 5 cos(30t) + 10

--

## Comprehensive Short Answer / Case Problems
01) A company’s weekly profit, in thousands of dollars, is modelled by P(x) = −2x² + 20x − 32, where x is the number of items sold in hundreds.
a) Find the break-even points and the maximum weekly profit.
b) The company receives a $15,000 bonus and invests it at 5.4% per year, compounded quarterly, for 6 years. Determine the future value of the investment.
c) The number of items sold is expected to grow by 7% each year. If 800 items are sold this year, write an exponential model for sales and predict the number sold after 4 years.

02) A Ferris wheel has a maximum height of 17 m and a minimum height of 1 m. It completes one full rotation every 60 s. A rider starts at the lowest point at t = 0.
a) Write a sinusoidal equation h(t) = a cos[k(t − d)] + c that models the rider’s height h, in metres, after t seconds. State the amplitude, axis, and period.
b) Using the transformation statement, map the parent point (90°, 0) on y = cos t to the graph of h(t), and interpret the result as the rider’s height at a particular time.
c) A point on the terminal arm of an angle θ in standard position is (−3/5, 4/5). Determine the exact values of sin θ, cos θ, and tan θ, and state the quadrant of θ.
d) State the domain and range of h(t) in the real-world context.

03) A fish population in a lake is modelled by P(t) = 5000(0.92)^t, where t is the number of years since 2020.
a) Identify the initial population, the annual decay rate, and state the domain and range in context.
b) Predict the fish population in 2030, to the nearest fish.
c) Write the first four terms of the population sequence and give the general term tₙ. Classify the sequence.
d) Determine the sum of the population over the first five years, using a geometric series formula. Interpret the result in context.

04) A triangular park has side a = 120 m, side b = 150 m, and contained angle C = 65°.
a) Use the Cosine Law to find the length of side c, to the nearest metre.
b) Use the area formula Area = (1/2)ab sin C to find the area of the park, to the nearest square metre.
c) The cost to landscape the park is modelled by C(x) = 0.5x² + 20x + 500, where x is the area in hundreds of square metres and C is in dollars. If the budget is $6,000, determine the maximum area that can be landscaped, to the nearest square metre.

--

## Answers & Detailed Solutions
01) B - A function has exactly one y-value for each x-value. In set B, each x-coordinate (1, 2, 3, 4) appears only once. Sets A, C, and D repeat an x-value with different y-values, so they are not functions. (Unit 1: definition of a function.)

02) A - Let y = (x + 3)² − 5. Swap x and y: x = (y + 3)² − 5. Solve: x + 5 = (y + 3)², so y + 3 = ±√(x + 5). Since the original domain is x ≥ −3, the inverse must use the positive root: y = √(x + 5) − 3. Thus f⁻¹(x) = √(x + 5) − 3. (Unit 1: inverse functions and domain restrictions.)

03) B - The zeros are x = 3 and x = 7, so the axis of symmetry is x = (3 + 7)/2 = 5. P(5) = −2(5 − 3)(5 − 7) = −2(2)(−2) = 8. Since P is in hundreds of dollars, the maximum profit is $800. (Unit 1: quadratic functions and real-world optimization.)

04) C - 81^(3/2) = (√81)³ = 9³ = 729. (Unit 2: rational exponents and exponent laws.)

05) B - In a table, an exponential function has a constant ratio between consecutive y-values. A quadratic function has constant second differences. (Unit 2: identifying exponential functions.)

06) A - f(4) = 28000(0.83)⁴ ≈ 28000(0.474583) ≈ 13288.33. To the nearest dollar, the value is $13,288. (Unit 2: exponential decay application.)

07) A - d = 264 − 278 = −14. Each term decreases by 14. (Unit 3: arithmetic sequences.)

08) A - This is arithmetic with a = 6, d = 3, n = 20. S₂₀ = (20/2)[2(6) + (20 − 1)(3)] = 10[12 + 57] = 690. (Unit 3: arithmetic series.)

09) B - Compound interest is exponential growth because each period’s balance is multiplied by the same factor (1 + i). The year-end balances form a geometric sequence with common ratio (1 + i). (Unit 3: connecting financial applications to sequences and exponential functions.)

10) A - cos x tan x = cos x (sin x / cos x) = sin x, provided cos x ≠ 0. (Unit 4: trigonometric identities and quotient identity.)

11) A - For y = −2 sin[1/2(x − 60°)] + 3: a = −2 gives a reflection in the x-axis and a vertical stretch by 2; k = 1/2 gives a horizontal stretch by 2; d = 60° gives a phase shift 60° right; c = 3 gives a vertical shift 3 units up. (Unit 4: transformations of sinusoidal functions.)

12) A - Amplitude = (10 − 5)/2 = 2.5 m. Axis = (10 + 5)/2 = 7.5 m. Period = 12 h, so k = 360/12 = 30. High tide at t = 0 means the cosine graph starts at a maximum, so h(t) = 2.5 cos(30t) + 7.5. (Unit 4: sinusoidal modelling.)

### Comprehensive Short Answer / Case Problems — Detailed Solutions

01)
a) Break-even: P(x) = 0 → −2x² + 20x − 32 = 0 → x² − 10x + 16 = 0 → (x − 2)(x − 8) = 0, so x = 2 or x = 8. Break-even occurs at 200 items and 800 items. Maximum profit occurs at the vertex: x = −b/(2a) = −20/(−4) = 5. P(5) = −2(25) + 20(5) − 32 = 18, so the maximum weekly profit is $18,000 at 500 items sold. (Unit 1: quadratic functions.)

b) Use A = P(1 + r/m)^(mt). P = 15000, r = 0.054, m = 4, t = 6. A = 15000(1 + 0.054/4)²⁴ = 15000(1.0135)²⁴ ≈ $20,694.80. (Unit 3: compound interest.)

c) Sales model: S(t) = 800(1.07)^t. After 4 years, S(4) = 800(1.07)⁴ ≈ 1048.64, so about 1049 items. (Unit 2: exponential growth.)

02)
a) Amplitude a = (17 − 1)/2 = 8. Axis c = (17 + 1)/2 = 9. Period = 60 s, so k = 360/60 = 6. Starting at the lowest point at t = 0 means use a negative cosine: h(t) = −8 cos(6t) + 9. Amplitude = 8 m, axis: h = 9 m, period = 60 s. (Unit 4: sinusoidal modelling.)

b) For y = cos t, the parent point (90°, 0) maps as x → x/k + d and y → a y + c. Here a = −8, k = 6, d = 0, c = 9. So (90°, 0) → (90/6 + 0, −8(0) + 9) = (15, 9). This means at t = 15 s, the rider is 9 m above the ground. (Unit 1 and Unit 4: transformations.)

c) For P(−3/5, 4/5), x = −3/5, y = 4/5, r = 1. Thus sin θ = y = 4/5, cos θ = x = −3/5, and tan θ = y/x = (4/5)/(−3/5) = −4/3. Since x < 0 and y > 0, θ is in Quadrant II. (Unit 4: unit circle and exact ratios.)

d) In context, time t ≥ 0, so domain: {t ∈ R | t ≥ 0}. The height ranges from 1 m to 17 m, so range: {h ∈ R | 1 ≤ h ≤ 17}. (Unit 1: domain and range in real-world context.)

03)
a) Initial population = 5000 fish. Decay factor = 0.92, so decay rate = 1 − 0.92 = 0.08 = 8% per year. Domain: {t ∈ R | t ≥ 0}. Range: {P ∈ R | 0 < P ≤ 5000}. (Unit 2 and Unit 1.)

b) In 2030, t = 10. P(10) = 5000(0.92)¹⁰ ≈ 5000(0.434388) ≈ 2171.94, so about 2172 fish. (Unit 2: exponential decay.)

c) First four terms: t₁ = 5000, t₂ = 5000(0.92) = 4600, t₃ = 4600(0.92) = 4232, t₄ = 4232(0.92) = 3893.44. General term: tₙ = 5000(0.92)^(n−1). This is a geometric sequence with common ratio r = 0.92. (Unit 3: geometric sequences.)

d) Sum of first 5 terms: S₅ = a(1 − r⁵)/(1 − r) = 5000(1 − 0.92⁵)/(1 − 0.92) = 5000(1 − 0.6590815)/0.08 ≈ 21307.4. This represents about 21,307 fish-years over the first five years. (Unit 3: geometric series.)

04)
a) Cosine Law: c² = a² + b² − 2ab cos C = 120² + 150² − 2(120)(150) cos 65°. c² = 14400 + 22500 − 36000(0.422618) ≈ 36900 − 15214.26 = 21685.74. c = √21685.74 ≈ 147.26 m, so c ≈ 147 m. (Unit 4: Cosine Law.)

b) Area = (1/2)ab sin C = (1/2)(120)(150) sin 65° = 9000(0.906308) ≈ 8156.77 m², so the area is about 8157 m². (Unit 4: area of a triangle using trigonometry.)

c) Budget equation: 0.5x² + 20x + 500 = 6000 → 0.5x² + 20x − 5500 = 0 → x² + 40x − 11000 = 0. Using the quadratic formula: x = [−40 + √(1600 + 44000)]/2 = [−40 + √45600]/2 ≈ (−40 + 213.542)/2 ≈ 86.771. Since x is in hundreds of square metres, maximum area ≈ 86.771 × 100 = 8677.1 m², or about 8677 m². (Unit 1: solving quadratic equations and applications.)
