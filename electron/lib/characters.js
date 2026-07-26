'use strict'

// Marvel Rivals character IDs — asset paths look like .../Characters/<id>/<id><costume>/...
// Sourced from soundKit_MR + the community audio sheet, current to Season 9.
const CHARACTERS = {
  1011: 'Hulk',
  1014: 'The Punisher',
  1015: 'Storm',
  1016: 'Loki',
  1017: 'Human Torch',
  1018: 'Doctor Strange',
  1020: 'Mantis',
  1021: 'Hawkeye',
  1022: 'Captain America',
  1023: 'Rocket Raccoon',
  1024: 'Hela',
  1025: 'Cloak & Dagger',
  1026: 'Black Panther',
  1027: 'Groot',
  1028: 'Ultron',
  1029: 'Magik',
  1030: 'Moon Knight',
  1031: 'Luna Snow',
  1032: 'Squirrel Girl',
  1033: 'Black Widow',
  1034: 'Iron Man',
  1035: 'Venom',
  1036: 'Spider-Man',
  1037: 'Magneto',
  1038: 'Scarlet Witch',
  1039: 'Thor',
  1040: 'Mister Fantastic',
  1041: 'Winter Soldier',
  1042: 'Peni Parker',
  1043: 'Star-Lord',
  1044: 'Blade',
  1045: 'Namor',
  1046: 'Adam Warlock',
  1047: 'Jeff the Land Shark',
  1048: 'Psylocke',
  1049: 'Wolverine',
  1050: 'Invisible Woman',
  1051: 'The Thing',
  1052: 'Iron Fist',
  1053: 'Emma Frost',
  1054: 'Phoenix',
  1055: 'Daredevil',
  1056: 'Angela',
  1057: 'Deadpool',
  1058: 'Gambit',
  1059: 'Elsa Bloodstone',
  1060: 'White Fox',
  1061: 'Black Cat',
  1062: 'Devil Dinosaur',
  1063: 'Cyclops',
  1064: 'Jubilee',
  1065: 'Rogue',
  1066: 'The Hood'
}

// NPC ids — recognized so NPC-affecting mods don't get mislabeled as "Unknown"
const NPCS = {
  4011: 'Spider Zero (NPC)',
  4012: 'Master Weaver (NPC)',
  4016: 'Galacta Bot (NPC)',
  4017: 'Galacta (NPC)',
  4018: 'Galacta Bot Large (NPC)',
  4019: 'Ultron Drone (NPC)',
  8021: 'Loki Ghost (NPC)',
  8041: 'Shuri (NPC)',
  8042: 'Bast (NPC)',
  8052: 'AllBlack (NPC)',
  8053: 'Knull (NPC)',
  8061: 'Herbie (NPC)'
}

// Name keywords for fallback detection from mod titles / archive file names.
// All lowercase; matched against a lowercased, de-punctuated string.
const NAME_KEYWORDS = {
  1011: ['hulk', 'bruce banner'],
  1014: ['punisher', 'frank castle'],
  1015: ['storm', 'ororo'],
  1016: ['loki'],
  1017: ['human torch', 'johnny storm'],
  1018: ['doctor strange', 'dr strange', 'stephen strange'],
  1020: ['mantis'],
  1021: ['hawkeye', 'clint barton'],
  1022: ['captain america', 'steve rogers'],
  1023: ['rocket raccoon', 'rocket'],
  1024: ['hela'],
  1025: ['cloak and dagger', 'cloak dagger', 'dagger', 'cloak'],
  1026: ['black panther', 'tchalla', 't challa'],
  1027: ['groot'],
  1028: ['ultron'],
  1029: ['magik', 'illyana'],
  1030: ['moon knight', 'moonknight'],
  1031: ['luna snow', 'luna'],
  1032: ['squirrel girl'],
  1033: ['black widow', 'natasha'],
  1034: ['iron man', 'ironman', 'tony stark'],
  1035: ['venom'],
  1036: ['spider man', 'spiderman', 'spider-man', 'peter parker'],
  1037: ['magneto'],
  1038: ['scarlet witch', 'wanda'],
  1039: ['thor'],
  1040: ['mister fantastic', 'mr fantastic', 'reed richards'],
  1041: ['winter soldier', 'bucky'],
  1042: ['peni parker', 'peni'],
  1043: ['star lord', 'starlord', 'star-lord'],
  1044: ['blade'],
  1045: ['namor'],
  1046: ['adam warlock', 'warlock'],
  1047: ['jeff the land shark', 'jeff'],
  1048: ['psylocke'],
  1049: ['wolverine', 'logan'],
  1050: ['invisible woman', 'sue storm'],
  1051: ['the thing', 'ben grimm'],
  1052: ['iron fist', 'ironfist'],
  1053: ['emma frost'],
  1054: ['phoenix', 'jean grey'],
  1055: ['daredevil', 'matt murdock'],
  1056: ['angela'],
  1057: ['deadpool', 'wade wilson'],
  1058: ['gambit'],
  1059: ['elsa bloodstone'],
  1060: ['white fox'],
  1061: ['black cat', 'felicia'],
  1062: ['devil dinosaur'],
  1063: ['cyclops', 'scott summers'],
  1064: ['jubilee', 'jubilation lee'],
  1065: ['rogue'],
  1066: ['the hood', 'parker robbins']
}

function characterName (id) {
  return CHARACTERS[id] || NPCS[id] || null
}

function allCharacters () {
  return Object.entries(CHARACTERS)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Longest keywords first so "spider man" wins over "man"-ish partials
const KEYWORD_LIST = Object.entries(NAME_KEYWORDS)
  .flatMap(([id, words]) => words.map(w => ({ id: Number(id), word: w })))
  .sort((a, b) => b.word.length - a.word.length)

// Archive authors frequently remove every separator (BlackPanther,
// WinterSoldier, DrStrange). Only compact multi-word aliases here; compacting
// short single words could turn unrelated text such as "author" into Thor.
const COMPACT_KEYWORD_LIST = KEYWORD_LIST
  .filter(x => /\s/.test(x.word))
  .map(x => ({ ...x, compact: x.word.replace(/[^a-z0-9]/g, '') }))

function detectCharactersFromText (text) {
  const clean = String(text || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_\-.]+/g, ' ')
  const compact = clean.replace(/[^a-z0-9]/g, '')
  const found = new Set()
  for (const { id, word } of KEYWORD_LIST) {
    const matched = /\s/.test(word) || word.length >= 5
      ? clean.includes(word)
      : new RegExp(`(?:^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i').test(clean)
    if (matched) found.add(id)
  }
  for (const { id, compact: word } of COMPACT_KEYWORD_LIST) {
    if (compact.includes(word)) found.add(id)
  }
  // "storm" alone is ambiguous with Human Torch's "johnny storm" / Sue "storm";
  // if a more specific match already claimed it, drop bare-storm false positives.
  if (found.has(1015) && (found.has(1017) || found.has(1050))) {
    if (!/\bstorm\b(?!.*(torch|johnny|sue|invisible))/.test(clean)) found.delete(1015)
  }
  return [...found]
}

module.exports = { CHARACTERS, NPCS, characterName, allCharacters, detectCharactersFromText }
