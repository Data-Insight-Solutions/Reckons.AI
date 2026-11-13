/**
 * The story a generated site example tells about its own making (F292.1, kb:site-build-story).
 *
 * Pure: takes counts and node IRIs the generator already holds, returns triples in the app's story
 * vocabulary (src/lib/rdf/story.ts: story:Story, story:Step, partOf, order, title, content, highlight).
 * Every number in a caption is a count passed in from the build, never typed here, and every highlight is a
 * node IRI passed in, so the generator can prove each one resolves inside the same example.
 *
 * Plain words for a first-time visitor. It says what the build did; it states no control the build lacks:
 * the expiry step reports the dated facts the pages carry today, and when there are none it says so.
 */
export const STORY = 'urn:reckons:story/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';

export interface StoryFact { iri: string; label: string; validUntil: string | null; pageCount: number }

/** Who is behind the site, as the About and Services pages state it; counts come from the build. */
export interface StoryWho {
  personIri: string; personName: string; role: string; titles: string[];
  orgIri: string; orgName: string | null; formed: string | null; place: string | null;
  services: number; credentials: number; recognition: number;
  highlights: string[];
}

export interface StoryInput {
  /** Present when the About page names a person; adds the step that introduces them. */
  who?: StoryWho;
  storyIri: string;
  stepIri: (n: number) => string;
  siteName: string;
  siteIri: string;
  blogIri: string | null;
  checkIri: string;
  /** Node IRIs of the published pages (not posts), in a stable order. */
  pageNodes: string[];
  pages: number;
  posts: number;
  /** The one line stated on every page, written once in the site's settings. */
  shared: { iri: string; text: string; pageCount: number };
  /** Facts that carry a valid-until date or an open date. */
  expiring: StoryFact[];
}

export type StoryTriple = { s: string; p: string; o: { iri: string } | { text: string } | { integer: number } };

const STEP_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const n = (count: number, one: string, many: string): string => count + ' ' + (count === 1 ? one : many);

export function storySteps(i: StoryInput): { title: string; content: string; highlights: string[] }[] {
  const total = i.pages + i.posts;
  const dated = i.expiring.filter((f) => f.validUntil !== null);
  const open = i.expiring.filter((f) => f.validUntil === null);
  const expiryText = i.expiring.length === 0
    ? 'Some things stop being true on a known day: a certificate runs out, an offer ends. A page can mark such a line with the date it stops being true. Today none of the ' + total + ' pages carries one, so there is nothing to flag. The check still runs on every build: it lists anything past its date, warns 60 days ahead, and the build refuses to publish a page that states a fact already past its date, naming the fact and the page.'
    : 'Some things stop being true on a known day. ' + (dated.length ? n(dated.length, 'fact on this site carries', 'facts on this site carry') + ' an end date: ' + dated.map((f) => f.label + ' (valid until ' + f.validUntil + ')').join('; ') + '. ' : '')
      + (open.length ? n(open.length, 'fact has', 'facts have') + ' no date yet, so each is an open question for its owner rather than a guess: ' + open.map((f) => f.label).join('; ') + '. ' : '')
      + 'On every build the check lists anything past its date, warns 60 days ahead, and refuses to publish a page that states an expired fact, naming the fact and the page.';
  const w = i.who;
  const whoStep = w ? [{
    title: 'Who is behind the site',
    content: w.personName + ' is the ' + w.role + ' of ' + (w.orgName ?? i.siteName) + (w.formed ? ', formed in ' + w.formed : '') + (w.place ? ', in ' + w.place : '')
      + '.' + (w.titles.length ? ' The About page describes the work as ' + w.titles.join(' and ') + '.' : '') + ' From the About and Services pages this example holds '
      + n(w.services, 'service', 'services') + ', ' + n(w.credentials, 'credential', 'credentials') + (w.recognition ? ', ' + n(w.recognition, 'recognition', 'recognitions') : '')
      + ', each one marked with the page that states it. Open the person or the company to see them connected to the services, the posts that cover them and the dated credential.',
    highlights: w.highlights,
  }] : [];
  const steps = [
    {
      title: 'Where the content came from',
      content: 'This example is the published website of ' + i.siteName + ', read in as sources: ' + n(i.pages, 'page', 'pages') + ' and ' + n(i.posts, 'blog post', 'blog posts') + ', ' + total + ' in all. The owner also kept private notes, which were used to check claims on the site but are not part of this example, and no content from them is included here.',
      highlights: [i.siteIri, ...(i.blogIri ? [i.blogIri] : [])],
    },
    {
      title: 'Pages made from one set of facts',
      content: 'Each page is one entry here with its title, address and place in the site: ' + n(i.pages, 'page', 'pages') + ' and ' + n(i.posts, 'post', 'posts') + '. The website builder reads the same page files this example was made from and turns them into the pages visitors read, with one shared set of settings for the menu, the footer and the look.',
      highlights: i.pageNodes.slice(0, 8),
    },
    {
      title: 'One fact, stated on many pages',
      content: 'The line at the foot of every page, "' + i.shared.text + '", is written once, in the site\'s settings, and the build puts it on all ' + i.shared.pageCount + ' pages and posts. Change it there once and the next build changes every page; nobody has to find and edit ' + i.shared.pageCount + ' copies. The lit node is that one fact, and it links to each page that shows it.',
      highlights: [i.shared.iri],
    },
    {
      title: 'Facts that expire',
      content: expiryText,
      highlights: i.expiring.length ? i.expiring.map((f) => f.iri) : [i.checkIri],
    },
    {
      title: 'The live website',
      content: 'The result is the live website, ' + total + ' pages and posts built from this one source. The site node is lit; its link opens the real website, so you can compare what you have just walked through with what a visitor sees.',
      highlights: [i.siteIri],
    },
  ];
  return [steps[0], ...whoStep, ...steps.slice(1)];
}

export function storyTriples(i: StoryInput): StoryTriple[] {
  const out: StoryTriple[] = [
    { s: i.storyIri, p: RDF_TYPE, o: { iri: STORY + 'Story' } },
    { s: i.storyIri, p: RDFS_LABEL, o: { text: 'How this website was made' } },
    { s: i.storyIri, p: STORY + 'description', o: { text: 'How the content, the pages and the checks behind this website came together, in ' + STEP_WORDS[storySteps(i).length] + ' short steps.' } },
    { s: i.storyIri, p: STORY + 'autoplay', o: { text: 'false' } },
  ];
  storySteps(i).forEach((st, k) => {
    const step = i.stepIri(k + 1);
    out.push(
      { s: step, p: RDF_TYPE, o: { iri: STORY + 'Step' } },
      { s: step, p: STORY + 'partOf', o: { iri: i.storyIri } },
      { s: step, p: STORY + 'order', o: { integer: k + 1 } },
      { s: step, p: STORY + 'title', o: { text: st.title } },
      { s: step, p: STORY + 'content', o: { text: st.content } },
      ...st.highlights.map((h): StoryTriple => ({ s: step, p: STORY + 'highlight', o: { iri: h } })),
    );
  });
  return out;
}

export { XSD_INT };
