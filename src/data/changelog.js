// Site changelog, rendered in About > "What's new".
//
// SCOPE: this is the history of THIS dashboard (antseed-zh.com) — what
// changed on the website. It is NOT the AntSeed protocol's changelog and must
// never be written as if it were: protocol/network facts belong in the
// Protocol tab and are sourced from the monorepo or antseed.com.
//
// SOURCING RULE: every entry must correspond to a change actually made in
// this repo. Dates come from the commit that shipped the change (or, for work
// still uncommitted, the day it went live on the site) — not from memory and
// not rounded to a nice-looking date. When adding an entry, take the date
// from `git log --date=short` for the relevant commit rather than guessing.
//
// Entries are newest-first. `tag` groups a change for the reader:
//   'feature' — something new you can now do
//   'fix'     — something that was wrong and now isn't (say what was wrong)
//   'data'    — a change to where a number comes from or how it's computed
// i18n: `titleKey`/`bodyKey` resolve against src/i18n/{en,zh}.js so the log
// is readable in both locales like the rest of the site.

export const CHANGELOG = [
  {
    date: '2026-09-18',
    tag: 'feature',
    titleKey: 'changelog.market.title',
    bodyKey: 'changelog.market.body',
  },
  {
    date: '2026-09-18',
    tag: 'fix',
    titleKey: 'changelog.epochChartEmpty.title',
    bodyKey: 'changelog.epochChartEmpty.body',
  },
  {
    date: '2026-09-17',
    tag: 'feature',
    titleKey: 'changelog.epochCountdown.title',
    bodyKey: 'changelog.epochCountdown.body',
  },
  {
    date: '2026-09-17',
    tag: 'data',
    titleKey: 'changelog.referencePrices.title',
    bodyKey: 'changelog.referencePrices.body',
  },
  {
    date: '2026-09-17',
    tag: 'fix',
    titleKey: 'changelog.modelMerge.title',
    bodyKey: 'changelog.modelMerge.body',
  },
  {
    date: '2026-09-17',
    tag: 'feature',
    titleKey: 'changelog.byModel.title',
    bodyKey: 'changelog.byModel.body',
  },
  {
    date: '2026-09-16',
    tag: 'feature',
    titleKey: 'changelog.protocolTab.title',
    bodyKey: 'changelog.protocolTab.body',
  },
  {
    date: '2026-09-16',
    tag: 'feature',
    titleKey: 'changelog.antsMerge.title',
    bodyKey: 'changelog.antsMerge.body',
  },
  {
    date: '2026-09-15',
    tag: 'feature',
    titleKey: 'changelog.autoReload.title',
    bodyKey: 'changelog.autoReload.body',
  },
  {
    date: '2026-09-15',
    tag: 'fix',
    titleKey: 'changelog.rewardsFormula.title',
    bodyKey: 'changelog.rewardsFormula.body',
  },
  {
    date: '2026-09-15',
    tag: 'feature',
    titleKey: 'changelog.epochData.title',
    bodyKey: 'changelog.epochData.body',
  },
  {
    date: '2026-09-15',
    tag: 'data',
    titleKey: 'changelog.rewriteV2.title',
    bodyKey: 'changelog.rewriteV2.body',
  },
  {
    date: '2026-09-12',
    tag: 'feature',
    titleKey: 'changelog.recognizedUsage.title',
    bodyKey: 'changelog.recognizedUsage.body',
  },
];
