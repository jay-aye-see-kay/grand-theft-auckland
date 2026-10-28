// Parody names for the gazetteer's businesses (places.ts), so no real
// business or brand name reaches the game (GTA parody, CLAUDE.md). Public
// places (parks, wharves, landmarks, libraries) keep their real names.
//
// Names are deterministic per OSM element: a chain's brand maps to its one
// parody (every Subway is Sub Par), and anything else hashes its OSM key
// into its kind's list of hand-written names, then into templates once the
// list is used up. Hash probing (rather than handing names out in order)
// means a new cafe in OSM only renames cafés it collides with, not every one
// after it. Hand picks go in overrides/<area>.json (`place.name`).
import type { Tags } from './osm.ts';

/** Real brand (OSM `brand`, or a name that starts with it) -> parody. Lower-case keys. */
const BRANDS: Record<string, string> = {
  // Takeaways
  'burger king': 'Kurger Bing',
  "mcdonald's": "Old Mac's",
  kfc: 'Kiwi Fried Kumara',
  subway: 'Sub Par',
  'pizza hut': 'Pizza Shed',
  "domino's": 'Domino Effect Pizza',
  'hell pizza': 'Heck Pizza',
  burgerfuel: 'Burger Diesel',
  'taco bell': 'Taco Smell',
  'krispy kreme': 'Squishy Scream',
  "dunkin'": 'Dunked',
  "nando's": "Nan-doh's",
  "denny's": "Lenny's",
  wahlburgers: 'Walrus Burgers',
  'pita pit': 'Pita Bitter',
  "sal's pizza": "Sol's Pizza",
  "st pierre's sushi": 'Saint Sushi',
  'potato corner': 'Spud Corner',
  // Coffee
  starbucks: 'Sparebucks',
  "gloria jean's": "Gloria's Jeans",
  'the coffee club': 'The Coffee Cult',
  'wild bean cafe': 'Mild Bean Cafe',
  allpress: 'Allstress Espresso',
  // Groceries and grog
  woolworths: 'Count Up',
  countdown: 'Count Up',
  'new world': 'Old World',
  'four square': 'Five Square',
  "pak'nsave": "Pak 'n Slave",
  'circle k': 'Square K',
  // Shops
  'the warehouse': 'The Warewhare',
  'chemist warehouse': 'Chemist Warewhare',
  'mountain warehouse': 'Molehill Warewhare',
  farmers: 'Farmhands',
  whitcoulls: 'Witscrawls',
  'jb hi-fi': 'JB Lo-Fi',
  'noel leeming': 'Noel Steaming',
  'pb tech': 'PB&J Tech',
  kathmandu: "Kathman-don't",
  macpac: 'Packmac',
  'rebel sport': 'Rebel Without a Sport',
  daiso: 'Dai-So-So',
  'cotton on': 'Cotton Off',
  glassons: 'Glasses On',
  'hallenstein brothers': 'Hallenstein Cousins',
  'h&m': 'Hem & Haw',
  unichem: 'Unchem',
  lush: 'Mush',
  placemakers: 'Placebo Makers',
  'number one shoes': 'Number Two Shoes',
  'foot locker': 'Toe Locker',
  nike: 'Nikau',
  adidas: "Adidon'ts",
  vans: 'Utes',
  skechers: "Sketchy's",
  'new balance': 'Old Imbalance',
  ugg: 'UGH',
  'the north face': 'The South Face',
  allbirds: 'Allmoas',
  lacoste: 'Lacost-a-Lot',
  'tommy hilfiger': 'Tommy Hillbilly',
  'hugo boss': 'Hugo Bossy',
  huffer: 'Puffer',
  dangerfield: 'Dangerzone',
  'rodd & gunn': 'Rodd & Pun',
  'louis vuitton': 'Louie Fluffon',
  gucci: 'Goochie',
  prada: 'Nada',
  chanel: 'Channel 2',
  dior: 'Dire',
  cartier: 'Car-Tear',
  'tiffany & company': 'Taffeta & Co',
  bulgari: 'Vulgari',
  montblanc: 'Mont Bland',
  swarovski: 'Swearovski',
  'tag heuer': "TAG You're It",
  'max mara': 'Min Mara',
  coach: 'Bus',
  pandora: "Pandora's Lunchbox",
  aesop: 'Easop',
  'mac cosmetics': "MAC 'n' Cheese Cosmetics",
  'jo malone': 'So Alone',
  opsm: 'OOPS-M',
  'spark new zealand': 'Sparky',
  'one nz': 'One-ish NZ',
  '2degrees': '3degrees',
  // Banks
  anz: 'ANZAC Biscuit Bank',
  'asb bank': 'Auckland Savings & Debt',
  'bank of new zealand': 'Bank of Not Zealand',
  westpac: 'Wastepac',
  kiwibank: 'Weka Bank',
  tsb: 'TBS Bank',
  icbc: 'ICU Bank',
  // Fuel
  z: "Zed's Gas",
  mobil: 'Wobil',
  bp: 'BO Petrol',
  gull: 'Gull-ible',
  // Hotels
  skycity: 'High City',
  sofitel: 'Sofa-tel',
  ramada: 'Ramble Inn',
  hilton: 'Hilltop',
  'ibis budget': 'Ibis Fudget',
  travelodge: 'Travel Dodge',
  pullman: 'Pushman',
  mercure: 'Mercury Retrograde Hotel',
  'crowne plaza': 'Clowne Plaza',
  'jw marriott': 'JW Marry-Me',
  'park hyatt': 'Park Quiet',
  'four points by sheraton': 'Five Points',
  'rydges hotels & resorts': 'Ridges',
  millennium: 'Millennial',
  'cordis hotels': 'Cordless',
  qt: 'Cutie',
  'adina hotels': 'Ardina',
  voco: 'Loco',
  'econo lodge': 'Eco-No Lodge',
  'the sebel': 'The Rebel',
  intercontinental: 'InterCantankerous',
  // Fun and games, wheels
  'event cinemas': 'Uneventful Cinemas',
  imax: 'MINIMAX',
  timezone: 'Time Zoned',
  'anytime fitness': 'Sometimes Fitness',
  cityfitness: 'City Unfitness',
  'les mills': 'Les Sweats',
  ticketmaster: 'Ticketmonster',
  hertz: 'Hurts Car Hire',
  avis: 'Avoid Car Hire',
  budget: 'Fudget Car Hire',
  europcar: 'Europe-ish Car',
  ford: 'Fjord',
  cadillac: 'Cadillacking',
};

/** Hand-written names per kind, used first. */
const FIXED: Record<string, string[]> = {
  dairy: [
    'Lotto & Regret', 'Pie Warmer Supreme', 'The Mince & Cheese Emporium', 'Lolly Mixture', 'Pineapple Lump Sum',
    'Milk & Mutter', 'Dairy Godmother', 'Fizzy Drink Fiesta', 'Hokey Pokey Corner', 'Last Chance Dairy',
    'The Dairy Air', 'Chips & Dip Superette', 'Cheap As Chips', 'Bread & Butter Mart', 'Smokes & Sundries', 'Bro Mart',
  ],
  bar: [
    'The Drunken Pūkeko', "She'll Be Right Tavern", 'Last Ferry Lounge', 'The Southerly Buster', 'Chur Bar',
    'Sweet As Saloon', 'The Rusty Ute', 'Yeah Nah Bar', 'The Long Drop', "Six O'Clock Swill", 'The Handle',
    'Jug & Jandal', 'Box of Birds', 'Up the Boohai', 'Pack a Sad', 'Rattle Your Dags', 'Morning After Tavern',
    "Shout's On You", 'Hard Case', 'Two Pints Lounge',
  ],
  cafe: [
    'Oat Milk & Honey', 'Third Wave Goodbye', 'Bean There Café', 'Long Black Friday', 'The Smashed Avo Collective',
    'Espresso Yourself', 'Grounds for Divorce', 'Daily Grind', 'Bean & Gone', 'Cup of Joe Bloggs', 'Fluffy Business',
    'Cheese Scone Zone', 'Brew Ha Ha', 'Sip Happens', "Not Your Nana's", 'Latte Da', 'The Cosy Kumara',
    'Afghan Biscuit Bureau', 'Ginger Crunch Club', 'Louise Cake Lounge',
  ],
  takeaway: [
    'The Sausage Sizzle Palace', 'Greasy Spoon', 'Hot Chip Heaven', 'Pie Hole', 'Battered Everything', 'Chip Butty Shack',
    'Hot Dog Cart-el', 'Golden Kumara', 'Battered Sav', 'Scoop There It Is',
  ],
  restaurant: ['Brunch Punch', 'Bon Apple Tea', 'Rare Occasion', 'Steak Out', 'Diner-saur', 'Kai Time'],
  bakery: ['Pie Society', 'Knead to Know', 'Yeast Expectations', 'Doughy Business', 'Loaf Actually', 'Crumbs!', 'Steak & Cheese Please'],
  supermarket: ['Bag It Yourself', 'Trolley Wobble', 'Aisle Be Back'],
  liquor: ['Bottle-O-Rama', 'Booze Brothers', 'Liquor Lick-It', 'Grog Shop of Horrors', 'Wine Not?', 'Hops & Regret'],
  bank: ['Bank of Mortgage Stress', 'Kiwisaver-ish Holdings', 'First National Bank of the Bach', 'Overdraft & Sons', 'Interest Only Trust'],
  hotel: [
    'The Rainy Season Inn', 'Hotel Housing Crisis', 'Quay Card Suites', "The Snorin' Inn", 'Kip Inn', 'The Lumpy Mattress',
    'Pillow Talk Hotel', 'Room Service Optional', 'Hostel Takeover', 'Bunk & Disorderly', "Backpacker's Back Pain",
  ],
  pharmacy: ["Pharmer's Market", 'The Pill Box', 'Plasters & Potions', 'Lozenge Lounge'],
  fuel: ['Pump & Dump', "Fill 'er Up", 'Petrol Head'],
  cinema: ['Popcorn Palace', 'The Sticky Floor', 'Reel Good Cinemas'],
  gym: ['Sweat Shop', 'Gym Shady', 'Muscle Mussel', 'Swole Patrol', 'Flex Appeal', 'No Pain No Gain'],
  salon: [
    'Curl Up & Dye', 'Hair Force One', 'Mullet Over', 'Shear Madness', 'The Mane Event', 'Fade to Black', 'Hair Today',
    'Snip Snip Hooray', 'Combing Attractions', 'Nailed It', "Tat's Entertainment", 'Ink Different', 'Knead Some Help', 'Rub-a-Dub',
  ],
  gallery: ['Art Attack', 'Gallery of Questionable Taste', 'Easel Does It'],
  shop: [
    "Threads 'n' That", 'Clobber', 'Op Shop Couture', 'Togs & Clogs', 'Gumboot City', 'Stubbies & Singlets', 'Frock Off',
    'Sole Searching', 'If the Shoe Fits', 'Jandal Junction', 'Cloud Nine Vapes', 'Vape Escape', "Puff Daddy's",
    'Kiwiana Overload', 'Paua to the People', 'Tiki Tacky', 'Sheep Thrills', 'Novel Idea', 'Bound to Please',
    'Bling Bling Ltd', 'Pounamu & Pawn', 'Byte Me', 'Cell Block', 'Hard Drive Thru', "Hammers 'n' Snags",
  ],
};

/** Restaurant puns by OSM cuisine. */
const CUISINE_NAMES: Record<string, string[]> = {
  thai: ['Thai Me Up', 'Thai Tanic', 'Thai Fighter', 'Thai-ger Prawn'],
  indian: ['Curry Favour', 'Naan of Your Business', 'Tikka Chance on Me', 'Bhaji Jumping'],
  chinese: ['Wok This Way', "Wok 'n' Roll", 'Dumpling Darling', 'Noodle Around'],
  japanese: ['Sushi Roll Over', 'Ramen Holiday', 'Udon Know Me', 'Wasabi Wassup'],
  sushi: ['Sushi Roll Over', 'Raw Deal Sushi'],
  ramen: ['Ramen Holiday', 'Use Your Noodle'],
  korean: ['Seoul Food', 'Seoul Mates', 'Kimchi Chimney'],
  vietnamese: ['Pho Real', 'Pho-get About It', 'Banh Mi Up'],
  italian: ['Pasta La Vista', 'Lasagne Lounge', "Mamma Mia's Meatballs", 'Penne Pincher'],
  pizza: ['Pizza My Heart', 'Crust Issues', 'Slice Slice Baby'],
  mexican: ['Nacho Average', "Taco 'Bout It", 'Guac & Roll'],
  burger: ['Patty Wagon', 'Bun Intended', 'Burgatory'],
  seafood: ['The Codfather', 'Snapper Happy'],
  fish_and_chips: ["Fish 'n' Chups", 'The Codfather', 'Batter Days'],
  greek: ["It's All Greek", 'Feta Than Ever'],
  turkish: ['Kebabylon', 'Doner Party'],
  kebab: ['Kebabylon', 'Doner Party'],
  middle_eastern: ['Hummus Among Us'],
  malaysian: ['Laksa-Daisical'],
  spanish: ['Tapas the Morning'],
  tapas: ['Tapas the Morning'],
  french: ['Bon Apple Tea'],
  steak_house: ['Rare Occasion', 'Steak Out'],
  chicken: ['Wing It', 'Chick Magnet'],
};

/** What a kind's templates say they sell, by cuisine. */
const CUISINE_WORD: Record<string, string> = {
  thai: 'Thai', indian: 'Curry', chinese: 'Dumpling', japanese: 'Sushi', sushi: 'Sushi', ramen: 'Ramen', korean: 'BBQ',
  vietnamese: 'Pho', italian: 'Pasta', pizza: 'Pizza', mexican: 'Taco', burger: 'Burger', seafood: 'Fish',
  fish_and_chips: "Fish 'n' Chip", greek: 'Souvlaki', turkish: 'Kebab', kebab: 'Kebab', steak_house: 'Steak', chicken: 'Chicken',
  noodle: 'Noodle', dumpling: 'Dumpling', coffee_shop: 'Coffee', ice_cream: 'Ice Cream', dessert: 'Pudding',
};

const OWNERS = [
  'Big Kev', 'Uncle Trev', 'Aunty Shaz', 'Nana Jean', 'Bazza', 'Dazza', 'Gazza', 'Cuz', 'Bro', 'Hemi', 'Kiri',
  'Uncle Bruce', 'Jono', 'Lil Pete', 'Keith', 'Mad Mike', 'Honest Hone', 'Sneaky Steve', 'Lucky Lorraine', 'Dodgy Doug',
];
/** "The {adjective} {noun}" pairs, after the hand-written names. */
const THE: Record<string, [string[], string[]]> = {
  bar: [
    ['Drunken', 'Tipsy', 'Wobbly', 'Munted', 'Sozzled', 'Legless', 'Thirsty', 'Rowdy', 'Sleepy', 'Grumpy', 'Soggy', 'Salty'],
    ['Pūkeko', 'Weka', 'Kea', 'Tūī', 'Moa', 'Kiwi', 'Kākāpō', 'Wētā', 'Seagull', 'Possum', 'Sheep', 'Eel'],
  ],
  cafe: [
    ['Sunny', 'Sleepy', 'Cheeky', 'Wonky', 'Toasty', 'Steamy', 'Frothy', 'Jolly', 'Fancy', 'Humble'],
    ['Bean', 'Mug', 'Scone', 'Saucer', 'Pikelet', 'Lamington', 'Teaspoon', 'Muffin'],
  ],
  hotel: [
    ['Lumpy', 'Creaky', 'Saggy', 'Snoozy', 'Dozy', 'Damp', 'Draughty', 'Comfy', 'Noisy', 'Tidy'],
    ['Pillow Inn', 'Bunk House', 'Duvet Hotel', 'Hammock Lodge', 'Kip Inn', 'Mattress Suites', 'Snore Hotel', 'Sleep Inn'],
  ],
  restaurant: [
    ['Hungry', 'Greedy', 'Saucy', 'Spicy', 'Hearty', 'Peckish', 'Stuffed', 'Fancy-Pants', 'Crispy', 'Golden'],
    ['Fork', 'Spoon', 'Plate', 'Ladle', 'Gravy Boat', 'Pot', 'Kai Table', 'Napkin', 'Doggy Bag'],
  ],
};

/** "{owner}'s {a} {b}" once the rest is used up. */
const OWNED: Record<string, [string[], string[]]> = {
  dairy: [['Dairy', 'Superette', 'Mini Mart', 'Corner Store', 'Food Mart'], ['']],
  cafe: [['Brew', 'Bean', 'Cuppa', 'Flat White', 'Scone'], ['Bar', 'House', 'Hut', 'Shack', 'Lab']],
  restaurant: [['Kai'], ['Kitchen', 'House', 'Canteen', 'Diner', 'Palace', 'Shack', 'Grill']],
  takeaway: [['Takeaways', 'Hot Chips', 'Pies', 'Burgers', 'Fry-Up', 'Fish Supper', 'Toasties'], ['']],
  bakery: [['Pies', 'Bakery', 'Buns', 'Loaves'], ['']],
  supermarket: [['Supermarket', 'Food Barn'], ['']],
  liquor: [['Bottle Store', 'Grog Shop', 'Liquor Barn'], ['']],
  bank: [['Savings', 'Loans', 'Bank'], ['& Trust', '& Co', '']],
  hotel: [['Hotel', 'Inn', 'Lodge', 'Backpackers', 'Suites'], ['']],
  pharmacy: [['Pharmacy', 'Chemist'], ['']],
  fuel: [['Gas', 'Petrol'], ['']],
  cinema: [['Picture House', 'Flicks'], ['']],
  gym: [['Gym', 'Boot Camp', 'Pump Room', 'Sweatbox'], ['']],
  salon: [['Hair', 'Nails', 'Ink', 'Barber', 'Beauty'], ['Studio', 'Parlour', 'Lounge', 'Bar']],
  gallery: [['Gallery', 'Art Space'], ['']],
  shop: [['Goods'], ['Emporium', 'Barn', 'Depot', 'Hut', 'Palace', 'Paradise', 'Mart', 'Outlet']],
  casino: [['Casino'], ['']],
};

/** What a shop's templates say it sells, by OSM shop=*. */
const SHOP_WORD: Record<string, string> = {
  clothes: 'Clobber', fashion: 'Frock', boutique: 'Frock', fashion_accessories: 'Frock', shoes: 'Jandal', jewelry: 'Bling',
  watches: 'Ticker', 'e-cigarette': 'Vape', tobacco: 'Smokes', gift: 'Kiwiana', souvenir: 'Kiwiana', books: 'Book',
  mobile_phone: 'Phone', computer: 'Gadget', electronics: 'Gadget', florist: 'Flower', bag: 'Bag', sports: 'Footy',
  outdoor: 'Tramping', bicycle: 'Bike', music: 'Record', musical_instrument: 'Ukulele', car: 'Car', car_repair: 'Panel Beater',
  toys: 'Toy', optician: 'Specs', second_hand: 'Op Shop', charity: 'Op Shop', ticket: 'Ticket', travel_agency: 'Holiday',
  laundry: 'Wash', dry_cleaning: 'Wash', tailor: 'Stitch', kitchen: 'Kitchen', pawnbroker: 'Pawn', photo: 'Photo',
  copyshop: 'Copy', games: 'Game', boat: 'Boat', variety_store: 'Two Dollar', department_store: 'Everything',
  mall: 'Everything', rental: 'Hire', storage_rental: 'Storage', health_food: 'Protein', nutrition_supplements: 'Protein',
  perfumery: 'Pong', stationery: 'Biro', hardware: 'Hardware', doityourself: 'Hardware', furniture: 'Couch',
  interior_decoration: 'Couch', shoe_repair: 'Heel', bureau_de_change: 'Money', butcher: 'Snag', greengrocer: 'Veg',
  seafood: 'Fish', deli: 'Deli', frame: 'Frame', craft: 'Craft', hifi: 'Speaker', video_games: 'Game', anime: 'Manga',
};

/** Kinds that keep their real (OSM) name. */
export const PUBLIC_KINDS = new Set(['landmark', 'park', 'wharf', 'museum', 'library', 'theatre', 'university', 'church', 'artwork', 'attraction', 'civic']);

/** 32-bit FNV-1a: stable across Node versions, unlike anything seeded by Math.random. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

const norm = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").trim();

/** The brand's parody, from a name that is or starts with a known brand (so a tail like "Hotel" is kept), else the brand tag. */
export function brandParody(tags: Tags): string | undefined {
  for (const v of [tags.name, tags.brand]) {
    if (!v) continue;
    const n = norm(v);
    if (BRANDS[n]) return BRANDS[n];
    // Longest brand first, so "Chemist Warehouse" beats nothing and "The Warehouse" doesn't eat it.
    const hit = PREFIXES.find((b) => n.startsWith(b + ' '));
    if (hit) return BRANDS[hit] + suffix(v.slice(hit.length));
  }
  return undefined;
}
/** Brands that are also ordinary words only match a whole name ("Budget Backpackers" isn't car hire). */
const WHOLE_NAME_ONLY = new Set(['budget', 'farmers', 'coach', 'millennium', 'timezone', 'pandora', 'mercure', 'ford', 'vans', 'lush', 'nike', 'gull']);
const PREFIXES = Object.keys(BRANDS)
  .filter((b) => b.length > 3 && !WHOLE_NAME_ONLY.has(b))
  .sort((a, b) => b.length - a.length);

/** "SkyCity Grand Hotel" -> " Grand Hotel": a generic tail after the brand is kept. */
function suffix(rest: string): string {
  const words = rest.trim().split(/\s+/).filter((w) => GENERIC_WORDS.has(w.toLowerCase()));
  return words.length && words.length === rest.trim().split(/\s+/).length ? ` ${words.join(' ')}` : '';
}
const GENERIC_WORDS = new Set(['hotel', 'grand', 'casino', 'theatre', 'express', 'bar', 'cafe', 'café', 'restaurant', 'store', 'auckland', 'central', 'city', 'apartments', 'suites']);

/** Hands out unique names: same element, same name, whatever else is in the data. */
export class Namer {
  private readonly used = new Set<string>();

  /** Names nothing else may take (hand picks from the overrides). */
  reserve(name: string) {
    this.used.add(name);
  }

  /** A parody for a business of `kind` with these tags, keyed by its OSM key. */
  name(key: string, kind: string, tags: Tags): string {
    const brand = brandParody(tags);
    if (brand) return brand; // chains share their parody, like the real thing
    const lists: string[][] = [];
    if (kind === 'restaurant' || kind === 'takeaway') {
      for (const c of cuisines(tags)) if (CUISINE_NAMES[c]) lists.push(CUISINE_NAMES[c]);
    }
    if (FIXED[kind]) lists.push(FIXED[kind]);
    const the = THE[kind];
    if (the) lists.push(the[0].flatMap((a) => the[1].map((b) => `The ${a} ${b}`)));
    const h = hash(key);
    for (const list of lists) {
      const pick = this.probe(list, h);
      if (pick) return pick;
    }
    let [a, b] = OWNED[kind] ?? OWNED.shop;
    // Say what's sold: "Bazza's Jandal Depot", "Kiri's Curry Kitchen".
    const sells = kind === 'restaurant' || kind === 'takeaway' ? cuisines(tags).map((c) => CUISINE_WORD[c]).find(Boolean) : kind === 'shop' ? SHOP_WORD[tags.shop] : undefined;
    if (sells) a = kind === 'shop' ? [sells] : [sells, ...a];
    const combos = OWNERS.flatMap((o) => a.flatMap((x) => b.map((y) => `${o}'s ${x}${y ? ' ' + y : ''}`)));
    const pick = this.probe(combos, h);
    if (pick) return pick;
    // Out of combinations: number them (never in the CBD today).
    for (let n = 2; ; n++) {
      const name = `${combos[h % combos.length]} No. ${n}`;
      if (!this.used.has(name)) return this.take(name);
    }
  }

  private probe(list: string[], h: number): string | undefined {
    // A step coprime with the length visits every entry once.
    let step = 1 + (Math.floor(h / list.length) % Math.max(1, list.length - 1));
    while (gcd(step, list.length) !== 1) step++;
    for (let k = 0; k < list.length; k++) {
      const name = list[(h + k * step) % list.length];
      if (!this.used.has(name)) return this.take(name);
    }
    return undefined;
  }

  private take(name: string): string {
    this.used.add(name);
    return name;
  }
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const cuisines = (tags: Tags) => (tags.cuisine ?? '').split(';').map((c) => c.trim().toLowerCase()).filter(Boolean);

/** Every name the generator can hand out, for the real-name check. */
export const ALL_PARODIES = new Set([
  ...Object.values(BRANDS),
  ...Object.values(FIXED).flat(),
  ...Object.values(CUISINE_NAMES).flat(),
]);
/** Real brands, for the leak check. */
export const REAL_BRANDS = Object.keys(BRANDS);
