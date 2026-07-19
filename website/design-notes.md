# ASV Agent Desk — Web Design Intelligence design note

## `index.html`

Project/topic: ASV Agent Desk public product and open-source release  
Page or site type: software product / developer tool  
Primary audience: macOS developers, Grok Build users, and open-source contributors  
Primary user action: inspect or clone the source  
Secondary user action: read setup and authentication guidance, then contribute  
Emotional tone: precise, technical, confident, expressive  
Content density: medium-high  
Device priority: desktop first, fully recomposed mobile  
Interaction level: medium  
Motion level: purposeful and restrained  
Trust requirement: high  
Conversion pressure: low  
Implementation stack: Vite-built semantic HTML, CSS, and small TypeScript interactions

Site type: software-product  
Audience: macOS developers, Grok Build users, and open-source contributors  
Primary action: view or clone the source  
Tone: precise, technical, confident  
Selected composition: product-walkthrough, presented as an annotated proof spine  
Why this composition fits: The product is a workflow system rather than a set of interchangeable features. Five numbered chapters can each reveal a distinct, real product capture and link directly to the deeper architecture or setup documentation. This satisfies the product-walkthrough signature and makes the application—not marketing decoration—the proof.  
Style atlas match: SaaS or Technical Product, using the app’s near-black layered surfaces, terminal density, and restrained blue interaction accent  
Reference/pattern moves borrowed (max 3): numbered chapter navigation; code-as-hero; speed-as-motion expressed only as byte and event traces  
Card budget / cards used / justification if > 0: budget 1 / used 0. The page uses an editorial proof spine, architecture ledger, and setup sequence.  
Forbidden defaults rejected: equal-height card wall; three columns under a centered hero; fake dashboard screenshot; pointless KPI strip; stock-icon feature grid; repeated two-column zig-zag; unearned gradient blob background; giant testimonial card row  
Product imagery provenance: captured-from-product @ public-release-candidate  
Motion behavior: One signature trace system animates byte flow and hook events through the architecture SVG and chapter spine. No decorative parallax, autoplay video, or continuous movement elsewhere.  
Responsive behavior (mobile composed, not squeezed): Desktop uses a vertical chapter rail paired with real product evidence. Tablet reduces annotation density. Mobile turns the rail into a linear reading sequence, moves all labels into document flow, and preserves clone/setup commands without horizontal page overflow.  
Accessibility fallback (reduced-motion, keyboard, no-JS): All narrative and proof content exists in initial HTML; the architecture remains legible as a static SVG; motion stops under `prefers-reduced-motion`; skip link, visible focus states, semantic landmarks, and 44px touch targets are required. Copy buttons retain selectable command text and degrade to manual copy.  
Performance risk: Real product imagery is the main weight risk. Use compressed WebP/AVIF with explicit dimensions, no video in the first release, self-hosted subset fonts, and lazy-load below-the-fold captures.

### Structural signature commitment

- Every numbered step exposes its own real product capture or a directly relevant code/architecture artifact.
- The walkthrough is visibly numbered 01–05 and reads as a system map.
- No single screenshot stands in for every step.
- Every capability claim links to public documentation or the repository.
- No icon-above-one-liner grid and no sourceless KPI figures.

