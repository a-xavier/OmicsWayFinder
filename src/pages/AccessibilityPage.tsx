import './AccessibilityPage.css'

type Criterion = readonly [id: string, title: string, level: 'A' | 'AA' | 'AAA']

type CriterionGroup = {
  id: string
  title: string
  criteria: readonly Criterion[]
}

const criterionGroups: readonly CriterionGroup[] = [
  {
    id: 'perceivable',
    title: '1. Perceivable',
    criteria: [
      ['1.1.1', 'Non-text Content', 'A'],
      ['1.2.1', 'Audio-only and Video-only (Prerecorded)', 'A'],
      ['1.2.2', 'Captions (Prerecorded)', 'A'],
      ['1.2.3', 'Audio Description or Media Alternative (Prerecorded)', 'A'],
      ['1.2.4', 'Captions (Live)', 'AA'],
      ['1.2.5', 'Audio Description (Prerecorded)', 'AA'],
      ['1.2.6', 'Sign Language (Prerecorded)', 'AAA'],
      ['1.2.7', 'Extended Audio Description (Prerecorded)', 'AAA'],
      ['1.2.8', 'Media Alternative (Prerecorded)', 'AAA'],
      ['1.2.9', 'Audio-only (Live)', 'AAA'],
      ['1.3.1', 'Info and Relationships', 'A'],
      ['1.3.2', 'Meaningful Sequence', 'A'],
      ['1.3.3', 'Sensory Characteristics', 'A'],
      ['1.3.4', 'Orientation', 'AA'],
      ['1.3.5', 'Identify Input Purpose', 'AA'],
      ['1.3.6', 'Identify Purpose', 'AAA'],
      ['1.4.1', 'Use of Color', 'A'],
      ['1.4.2', 'Audio Control', 'A'],
      ['1.4.3', 'Contrast (Minimum)', 'AA'],
      ['1.4.4', 'Resize Text', 'AA'],
      ['1.4.5', 'Images of Text', 'AA'],
      ['1.4.6', 'Contrast (Enhanced)', 'AAA'],
      ['1.4.7', 'Low or No Background Audio', 'AAA'],
      ['1.4.8', 'Visual Presentation', 'AAA'],
      ['1.4.9', 'Images of Text (No Exception)', 'AAA'],
      ['1.4.10', 'Reflow', 'AA'],
      ['1.4.11', 'Non-text Contrast', 'AA'],
      ['1.4.12', 'Text Spacing', 'AA'],
      ['1.4.13', 'Content on Hover or Focus', 'AA'],
    ],
  },
  {
    id: 'operable',
    title: '2. Operable',
    criteria: [
      ['2.1.1', 'Keyboard', 'A'],
      ['2.1.2', 'No Keyboard Trap', 'A'],
      ['2.1.3', 'Keyboard (No Exception)', 'AAA'],
      ['2.1.4', 'Character Key Shortcuts', 'A'],
      ['2.2.1', 'Timing Adjustable', 'A'],
      ['2.2.2', 'Pause, Stop, Hide', 'A'],
      ['2.2.3', 'No Timing', 'AAA'],
      ['2.2.4', 'Interruptions', 'AAA'],
      ['2.2.5', 'Re-authenticating', 'AAA'],
      ['2.2.6', 'Timeouts', 'AAA'],
      ['2.3.1', 'Three Flashes or Below Threshold', 'A'],
      ['2.3.2', 'Three Flashes', 'AAA'],
      ['2.3.3', 'Animation from Interactions', 'AAA'],
      ['2.4.1', 'Bypass Blocks', 'A'],
      ['2.4.2', 'Page Titled', 'A'],
      ['2.4.3', 'Focus Order', 'A'],
      ['2.4.4', 'Link Purpose (In Context)', 'A'],
      ['2.4.5', 'Multiple Ways', 'AA'],
      ['2.4.6', 'Headings and Labels', 'AA'],
      ['2.4.7', 'Focus Visible', 'AA'],
      ['2.4.8', 'Location', 'AAA'],
      ['2.4.9', 'Link Purpose (Link Only)', 'AAA'],
      ['2.4.10', 'Section Headings', 'AAA'],
      ['2.4.11', 'Focus Not Obscured (Minimum)', 'AA'],
      ['2.4.12', 'Focus Not Obscured (Enhanced)', 'AAA'],
      ['2.4.13', 'Focus Appearance', 'AAA'],
      ['2.5.1', 'Pointer Gestures', 'A'],
      ['2.5.2', 'Pointer Cancellation', 'A'],
      ['2.5.3', 'Label in Name', 'A'],
      ['2.5.4', 'Motion Actuation', 'A'],
      ['2.5.5', 'Target Size (Enhanced)', 'AAA'],
      ['2.5.6', 'Concurrent Input Mechanisms', 'AAA'],
      ['2.5.7', 'Dragging Movements', 'AA'],
      ['2.5.8', 'Target Size (Minimum)', 'AA'],
    ],
  },
  {
    id: 'understandable',
    title: '3. Understandable',
    criteria: [
      ['3.1.1', 'Language of Page', 'A'],
      ['3.1.2', 'Language of Parts', 'AA'],
      ['3.1.3', 'Unusual Words', 'AAA'],
      ['3.1.4', 'Abbreviations', 'AAA'],
      ['3.1.5', 'Reading Level', 'AAA'],
      ['3.1.6', 'Pronunciation', 'AAA'],
      ['3.2.1', 'On Focus', 'A'],
      ['3.2.2', 'On Input', 'A'],
      ['3.2.3', 'Consistent Navigation', 'AA'],
      ['3.2.4', 'Consistent Identification', 'AA'],
      ['3.2.5', 'Change on Request', 'AAA'],
      ['3.2.6', 'Consistent Help', 'A'],
      ['3.3.1', 'Error Identification', 'A'],
      ['3.3.2', 'Labels or Instructions', 'A'],
      ['3.3.3', 'Error Suggestion', 'AA'],
      ['3.3.4', 'Error Prevention (Legal, Financial, Data)', 'AA'],
      ['3.3.5', 'Help', 'AAA'],
      ['3.3.6', 'Error Prevention (All)', 'AAA'],
      ['3.3.7', 'Redundant Entry', 'A'],
      ['3.3.8', 'Accessible Authentication (Minimum)', 'AA'],
      ['3.3.9', 'Accessible Authentication (Enhanced)', 'AAA'],
    ],
  },
  {
    id: 'robust',
    title: '4. Robust',
    criteria: [
      ['4.1.2', 'Name, Role, Value', 'A'],
      ['4.1.3', 'Status Messages', 'AA'],
    ],
  },
]

export default function AccessibilityPage() {
  return (
    <div className="accessibility-page">
      <h1>Accessibility</h1>
      <p>
        OmicsWayFinder aims to make bioinformatics accessible to all users.
        This means two main things:
        <ul>
          <li>Ensuring the interface is usable by people with a wide range of abilities and disabilities. This means following the  <a href="https://www.w3.org/TR/WCAG22/" target="_blank" rel="noopener noreferrer">Web Content Accessibility Guidelines (WCAG) 2.2</a></li>
          <li>Providing clear guidance and support for users with varying levels of expertise in bioinformatics. This means exposing important decision while keeping fine-tuning parameters hidden but always available</li>
        </ul>    
      </p>

      <section className="accessibility-guidance" aria-labelledby="accessible-analysis-title">
        <h2 id="accessible-analysis-title">Accessible analysis for different experience levels</h2>
        <p>
          This project also focus on making bioinformatics accessible for non-specialists. The goal is to present the best tools for any given task, expose the most important arguments and options, auto-detect best arguments to use but still leave the option to override everything if you know what you are doing.
          We will research how to best present information to users and how to present complex bioinformatic decisions.
          This work will be done in collaboration with human-computer interaction experts.
        </p>
        <ul>
          <li><strong>Guided view:</strong> foreground the next decision, explain recommendations in plain language, and show which evidence supports them.</li>
          <li><strong>Expert control:</strong> keep the underlying tool, arguments, and values inspectable and editable rather than hiding them permanently.</li>
          <li><strong>Progressive detail:</strong> let users start with a manageable summary and open technical detail when they need it, without removing their control.</li>
        </ul>
      </section>

      <section className="wcag-checklist" aria-labelledby="wcag-checklist-title">
        <div className="wcag-checklist__header">
          <div>
            <h2 id="wcag-checklist-title">WCAG 2.2 success criteria</h2>
            <p>All 86 current criteria across Levels A, AA, and AAA.</p>
          </div>
        </div>

        <p className="wcag-disclaimer">
          OmicsWayfinder will strive to implement all success criteria applicable to its content and features. This checklist is a guide, not an audit or a claim of WCAG conformance; applicable criteria still need testing across complete pages and user flows. Criterion 4.1.1 was removed from WCAG 2.2 and is not listed here.
        </p>

        <div className="wcag-groups">
          {criterionGroups.map(group => (
            <details className="wcag-group" key={group.id}>
              <summary>{group.title}</summary>
              <ul className="wcag-items">
                {group.criteria.map(([id, title, level]) => (
                  <li className="wcag-item" key={id}>
                    <span className="wcag-item__criterion"><strong>{id}</strong> {title}</span>
                    <span className="wcag-item__level">Level {level}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </section>
    </div>
  )
}
