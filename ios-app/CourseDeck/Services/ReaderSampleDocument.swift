import Foundation

/// Rich, self-contained reader fixture used by the "Open reader sample"
/// action and by the app test target. It intentionally exercises every block
/// type the reader must support: headings, prose, inline math, links, inline
/// code, a table (including currency and math pipes), a callout with a nested
/// table, details, a USERNOTE card, a fenced code block, a task list, an SVG
/// image, a display equation, a blockquote, and a thematic break.
enum ReaderSampleDocument {
    static let markdown = #"""
    ---
    title: Reader sample
    course: sample
    ---

    # Reader sample

    This page exercises the native reader: **bold**, *italic*, ~~struck~~,
    `inline code`, [a course link](https://example.com), and inline math such as
    $x^2 + y^2 = z^2$ and $|x|$. Currency stays literal: $1,500 and $45,000.

    ## A table that must not lose cells

    | Account | Debit | Credit | Balance | Note |
    |:--------|------:|-------:|--------:|:-----|
    | Cash | $1,500 | $0 | $1,500 | Opening |
    | Inventory | $2,000 | $1,500 | $500 | $|x|$ |
    | Equipment | $45,000 | $0 | $45,000 | Long-lived |

    > [!NOTE] Ledger reminder
    > Protected values such as $|x|$ and `$1,500` must stay in one cell.
    >
    > | Item | Amount |
    > |------|-------:|
    > | Rent | $2,000 |

    ## Worked example

    <details>
    <summary>Show the worked answer</summary>

    The derivative measures the instantaneous rate of change.

    | Step | Expression | Result |
    |:-----|:-----------|-------:|
    | 1 | $3x^2 + 2x$ | $6x + 2$ |
    | 2 | $f'(2)$ | $14$ |

    </details>

    > [!USERNOTE] Why does this matter?
    > <!-- target: "The derivative measures" -->
    > This is the paragraph the note anchors to. The card is read-only in this
    > build, but the link should jump back to the target paragraph.

    ## Code and tasks

    ```swift
    let total = debits.reduce(0, +)
    let balanced = total == credits.reduce(0, +)
    ```

    - [x] Read the ledger
    - [ ] Reconcile the balance
    - [ ] Export the workbook

    ## Image and display math

    ![Deck icon](assets/icons/deck.svg)

    $$
    \int_0^1 x^2\,dx = \frac{1}{3}
    $$

    > A blockquote rendered in the same selectable prose run.

    ---

    Raw HTML that is not a supported table is flattened with a visible warning:

    <div class="aside">Flattened HTML content stays readable.</div>
    """#

    /// Deliberately valid SVG. It also runs through the quoted-printable repair
    /// path (`SVGLoader`), which is exercised by the BAF3M icon corpus.
    static let iconSVG = #"""
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect x="4" y="8" width="56" height="44" rx="6" fill="#0A84FF"/>
      <rect x="10" y="14" width="44" height="26" rx="3" fill="#FFFFFF" opacity="0.92"/>
      <path d="M18 22h28M18 30h20" stroke="#0A84FF" stroke-width="4" stroke-linecap="round"/>
      <circle cx="48" cy="48" r="10" fill="#FF9F0A"/>
    </svg>
    """#
}
