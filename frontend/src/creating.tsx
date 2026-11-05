import { useEffect, useState } from 'react';

export type Aspect = 'square' | 'landscape' | 'portrait';

const ASK = /\b(draw|paint|sketch|design|generate|create|make|render|illustrate|produce|imagine)\b/i;
const THING = /\b(image|images|picture|pictures|photo|logo|icon|poster|wallpaper|illustration|artwork|art|sticker|avatar|cartoon|drawing|banner|thumbnail|graphic|svg|portrait|mockup)\b/i;

// "draw / paint / sketch / illustrate ..." already means a picture ("draw a calm lake"), except for sayings like "draw a conclusion".
const DRAWING = /^(?:please\s+|can you\s+|could you\s+|kindly\s+|just\s+)*(?:draw|paint|sketch|illustrate)\b(?!\s+(?:a\s+|some\s+)?(?:conclusions?|attention|breath|blood|salary|water|curtains?|cards?|lots|straws?)\b)/i;

/** Does this message ask MJ to make a picture? (Used only to show the "creating" animation while the reply is on its way.) */
export function wantsImage(text: string): Aspect | null {
  const t = text.trim();
  if (t.length < 6 || !(DRAWING.test(t) || (ASK.test(t) && THING.test(t)) || /\b(image|picture|photo|drawing|painting) of\b/i.test(t))) return null;
  if (/\b(wallpaper|poster|phone|story|portrait|vertical|reel)\b/i.test(t)) return 'portrait';
  if (/\b(banner|landscape|desktop|cover|thumbnail|wide|scene|panorama|horizontal)\b/i.test(t)) return 'landscape';
  return 'square';
}

const STEPS = ['Creating your image...', 'Sketching the shapes...', 'Mixing the colours...', 'Adding the details...', 'Almost there...'];

/** The soft, shimmering placeholder shown while a picture is being made (like ChatGPT's image loading card). */
export function ImageCreating({ aspect }: { aspect: Aspect }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 4200);
    return () => clearInterval(t);
  }, []);
  return (
    <div className={`creating ${aspect}`} role="status" aria-label="MJ is creating an image">
      <i className="blob b1" />
      <i className="blob b2" />
      <i className="blob b3" />
      <i className="blob b4" />
      <span className="creating-label" key={step}>
        {STEPS[step]}
      </span>
    </div>
  );
}
