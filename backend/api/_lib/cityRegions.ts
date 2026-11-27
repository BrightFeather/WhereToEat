// Canonical city → borough → neighborhood mapping.
// Static data — NYC's boroughs and neighborhoods don't change, so we keep this
// as a TS constant rather than a DB table. To add a city, append to CITIES.

export interface BoroughRegion {
  name: string;
  neighborhoods: string[];
}

export interface CityRegions {
  city: string;
  boroughs: BoroughRegion[];
}

const NYC: CityRegions = {
  city: 'nyc',
  boroughs: [
    {
      name: 'Manhattan',
      neighborhoods: [
        'Financial District', 'Battery Park City', 'Tribeca', 'Chinatown', 'Little Italy',
        'Two Bridges', 'Lower East Side', 'Bowery', 'NoLita', 'NoHo', 'SoHo',
        'East Village', 'Greenwich Village', 'West Village', 'Meatpacking District',
        'Union Square', 'Gramercy', 'Flatiron', 'Chelsea', 'Kips Bay', 'Murray Hill',
        'Koreatown', 'Midtown', 'Midtown East', 'Midtown West', 'Times Square',
        'Theater District', "Hell's Kitchen", 'Hudson Yards',
        'Upper East Side', 'Upper West Side', 'Lincoln Square', 'Morningside Heights',
        'Harlem', 'East Harlem', 'Spanish Harlem', 'Washington Heights', 'Inwood',
        'Roosevelt Island',
      ],
    },
    {
      name: 'Brooklyn',
      neighborhoods: [
        'Williamsburg', 'Greenpoint', 'Bushwick', 'Bedford-Stuyvesant',
        'Crown Heights', 'Prospect Heights', 'Park Slope', 'Gowanus', 'Red Hook',
        'Carroll Gardens', 'Cobble Hill', 'Boerum Hill', 'Downtown Brooklyn',
        'DUMBO', 'Brooklyn Heights', 'Fort Greene', 'Clinton Hill',
        'Prospect Lefferts Gardens', 'Flatbush', 'Midwood', 'Kensington',
        'Borough Park', 'Sunset Park', 'Bay Ridge', 'Bensonhurst', 'Dyker Heights',
        'Bath Beach', 'Coney Island', 'Brighton Beach', 'Sheepshead Bay',
        'East New York', 'Brownsville', 'Canarsie', 'East Flatbush',
      ],
    },
    {
      name: 'Queens',
      neighborhoods: [
        'Long Island City', 'Astoria', 'Sunnyside', 'Woodside', 'Jackson Heights',
        'Elmhurst', 'Corona', 'Flushing', 'Whitestone', 'Bayside', 'Fresh Meadows',
        'Forest Hills', 'Rego Park', 'Kew Gardens', 'Richmond Hill', 'Ozone Park',
        'Jamaica', 'South Jamaica', 'Hollis', 'Queens Village', 'Far Rockaway',
        'Rockaway', 'Howard Beach', 'College Point', 'Ridgewood', 'Maspeth',
        'Middle Village', 'Glendale', 'Briarwood',
      ],
    },
    {
      name: 'Bronx',
      neighborhoods: [
        'Mott Haven', 'Melrose', 'Port Morris', 'Hunts Point', 'Morrisania',
        'Fordham', 'Belmont', 'Pelham Bay', 'Riverdale', 'Kingsbridge',
        'Bedford Park', 'Norwood', 'Woodlawn', 'Throgs Neck', 'Soundview',
        'Parkchester', 'Concourse', 'Highbridge', 'University Heights',
      ],
    },
    {
      name: 'Staten Island',
      neighborhoods: [
        'St. George', 'Tompkinsville', 'Stapleton', 'Port Richmond',
        'New Brighton', 'West Brighton', 'Tottenville', 'Great Kills', 'New Dorp',
      ],
    },
  ],
};

// SF Bay Area (city key `bay`). "Boroughs" are the five conventional regions;
// for San Francisco the entries are neighborhoods, for the other regions they
// are the city names (Places `locality`), which is how people pick outside SF.
// See agent_docs/bay-area-expansion.md.
const BAY: CityRegions = {
  city: 'bay',
  boroughs: [
    {
      name: 'San Francisco',
      neighborhoods: [
        'Financial District', 'Embarcadero', 'Chinatown', 'North Beach', 'Russian Hill',
        'Nob Hill', 'Union Square', 'Tenderloin', 'SoMa', 'South Beach', 'Rincon Hill',
        'Mission Bay', 'Dogpatch', 'Potrero Hill', 'Mission District', 'Bernal Heights',
        'Castro', 'Noe Valley', 'Glen Park', 'Duboce Triangle', 'Hayes Valley',
        'Lower Haight', 'Haight-Ashbury', 'NoPa', 'Western Addition', 'Japantown',
        'Pacific Heights', 'Marina District', 'Cow Hollow', "Fisherman's Wharf", 'Presidio',
        'Inner Richmond', 'Outer Richmond', 'Inner Sunset', 'Outer Sunset', 'Parkside',
        'Lakeside', 'Ingleside', 'Excelsior', 'Outer Mission', 'Visitacion Valley', 'Bayview',
      ],
    },
    {
      name: 'East Bay',
      neighborhoods: [
        'Oakland', 'Berkeley', 'Emeryville', 'Alameda', 'Albany', 'Piedmont', 'El Cerrito',
        'Richmond', 'San Leandro', 'Castro Valley', 'Hayward', 'Union City', 'Fremont',
        'Newark', 'Dublin', 'Pleasanton', 'Livermore', 'San Ramon', 'Danville',
        'Walnut Creek', 'Lafayette', 'Orinda', 'Moraga', 'Concord', 'Pleasant Hill', 'Martinez',
      ],
    },
    {
      name: 'Peninsula',
      neighborhoods: [
        'Daly City', 'Colma', 'South San Francisco', 'Brisbane', 'Pacifica', 'San Bruno',
        'Millbrae', 'Burlingame', 'San Mateo', 'Foster City', 'Belmont', 'San Carlos',
        'Redwood City', 'Menlo Park', 'Atherton', 'East Palo Alto', 'Palo Alto',
        'Los Altos', 'Los Altos Hills', 'Half Moon Bay',
      ],
    },
    {
      name: 'South Bay',
      neighborhoods: [
        'San Jose', 'Santa Clara', 'Sunnyvale', 'Mountain View', 'Cupertino', 'Milpitas',
        'Campbell', 'Saratoga', 'Los Gatos', 'Morgan Hill', 'Gilroy',
      ],
    },
    {
      name: 'North Bay',
      neighborhoods: [
        'Sausalito', 'Mill Valley', 'Tiburon', 'Corte Madera', 'Larkspur', 'San Rafael',
        'Novato', 'Petaluma', 'Sonoma', 'Santa Rosa', 'Healdsburg', 'Napa', 'Yountville',
        'St. Helena', 'Calistoga', 'Vallejo', 'Benicia',
      ],
    },
  ],
};

// Los Angeles + Orange County (city key `la`). Same scheme as `bay`: for the
// City of Los Angeles the entries are neighborhoods (Places `neighborhood`), for
// everything else they are city names (Places `locality`). LA-city neighborhoods
// on the Westside / harbor are listed under Westside / South Bay. In-bounds
// localities that aren't mapped land in "Other". See agent_docs/multi-city-expansion.md.
const LA: CityRegions = {
  city: 'la',
  boroughs: [
    {
      name: 'Los Angeles',
      neighborhoods: [
        'Koreatown', 'Downtown Los Angeles', 'Arts District', 'Little Tokyo', 'Chinatown',
        'Hollywood', 'East Hollywood', 'Los Feliz', 'Silver Lake', 'Echo Park', 'Highland Park',
        'Eagle Rock', 'Atwater Village', 'Fairfax', 'Mid-Wilshire', 'Hancock Park',
        'Larchmont', 'Mid-City', 'West Adams', 'Boyle Heights', 'Sherman Oaks', 'Studio City',
        'Encino', 'North Hollywood', 'Van Nuys', 'Tarzana', 'Woodland Hills',
        'Glendale', 'Burbank',
      ],
    },
    {
      name: 'San Gabriel Valley',
      neighborhoods: [
        'Alhambra', 'San Gabriel', 'Monterey Park', 'Arcadia', 'Rosemead', 'Temple City',
        'El Monte', 'South El Monte', 'Rowland Heights', 'Diamond Bar', 'Walnut',
        'Hacienda Heights', 'City of Industry', 'Industry', 'West Covina', 'Pasadena',
        'South Pasadena', 'San Marino', 'Chino Hills', 'Monrovia',
      ],
    },
    {
      name: 'Westside',
      neighborhoods: [
        'Santa Monica', 'Culver City', 'Beverly Hills', 'West Hollywood', 'Marina del Rey',
        'Marina Del Rey', 'Malibu', 'Venice', 'Westwood', 'Brentwood', 'Sawtelle',
        'West Los Angeles', 'Palms', 'Mar Vista', 'Playa Vista', 'Century City',
        'Pacific Palisades',
      ],
    },
    {
      name: 'South Bay',
      neighborhoods: [
        'Torrance', 'Gardena', 'Redondo Beach', 'Manhattan Beach', 'Hermosa Beach',
        'Long Beach', 'El Segundo', 'Hawthorne', 'Lomita', 'Carson', 'Rancho Palos Verdes',
        'Palos Verdes Estates', 'Rolling Hills Estates', 'San Pedro', 'Wilmington',
        'Harbor City',
      ],
    },
    {
      name: 'Orange County',
      neighborhoods: [
        'Irvine', 'Costa Mesa', 'Newport Beach', 'Anaheim', 'Fullerton', 'Tustin',
        'Garden Grove', 'Huntington Beach', 'Westminster', 'Santa Ana', 'Orange',
        'Buena Park', 'Laguna Beach', 'Laguna Niguel', 'Lake Forest', 'Mission Viejo',
        'Yorba Linda', 'Brea', 'Cypress', 'Fountain Valley', 'Seal Beach', 'Dana Point',
      ],
    },
    { name: 'Other', neighborhoods: [] },
  ],
};

const CITIES: Record<string, CityRegions> = {
  nyc: NYC,
  bay: BAY,
  la: LA,
};

export interface LatLngBounds {
  low: { latitude: number; longitude: number };
  high: { latitude: number; longitude: number };
}

/** Per-city knobs for the ingest + Places enrichment. */
export interface CityMeta {
  key: string;
  /** Human name used in LLM prompts ("New York City", "the San Francisco Bay Area"). */
  displayName: string;
  /** Appended after `<name> <locationHint>` in Places queries. */
  placesHintSuffix: string;
  /** Appended after `<name>` for the last-resort Places query. */
  placesFallbackSuffix: string;
  /** When set: Places searches are biased to this rectangle and results outside it are dropped. */
  bounds?: LatLngBounds;
}

const CITY_META: Record<string, CityMeta> = {
  // NYC keeps its original query strings and no bounds — behaviour unchanged.
  nyc: { key: 'nyc', displayName: 'New York City', placesHintSuffix: 'New York', placesFallbackSuffix: 'New York City' },
  bay: {
    key: 'bay',
    displayName: 'the San Francisco Bay Area',
    placesHintSuffix: 'CA',
    placesFallbackSuffix: 'San Francisco Bay Area, CA',
    // Gilroy/Santa Cruz line in the south → Santa Rosa/Napa in the north.
    bounds: { low: { latitude: 36.95, longitude: -123.15 }, high: { latitude: 38.65, longitude: -121.45 } },
  },
  la: {
    key: 'la',
    displayName: 'Los Angeles (including Orange County)',
    placesHintSuffix: 'CA',
    placesFallbackSuffix: 'Los Angeles, CA',
    // LA County + Orange County: Malibu/Santa Clarita edge → San Clemente / Inland Empire edge.
    bounds: { low: { latitude: 33.40, longitude: -118.95 }, high: { latitude: 34.45, longitude: -117.40 } },
  },
};

export function getCityMeta(city: string): CityMeta {
  const meta = CITY_META[city];
  if (!meta) throw new Error(`Unknown city key: ${city}`);
  return meta;
}

/**
 * Bay Area / LA: map a Places `locality` (city name) to its region. For LA,
 * locality "Los Angeles" is split by `neighborhood` (Venice → Westside,
 * San Pedro → South Bay, else Los Angeles), and unmapped localities → "Other".
 */
export function regionForLocality(city: string, locality: string | null | undefined, neighborhood?: string | null): string | null {
  const fallback = city === 'la' ? 'Other' : null;
  if (!locality) return fallback;
  const regions = CITIES[city]?.boroughs ?? [];
  if (city === 'bay' && locality === 'San Francisco') return 'San Francisco';
  if (city === 'la' && locality === 'Los Angeles') {
    const hit = neighborhood ? regions.find((r) => r.name !== 'Los Angeles' && r.neighborhoods.includes(neighborhood)) : undefined;
    return hit?.name ?? 'Los Angeles';
  }
  return regions.find((r) => r.neighborhoods.includes(locality))?.name ?? fallback;
}

export function getCityRegions(city: string): CityRegions | null {
  return CITIES[city] ?? null;
}

export function getBoroughNames(city: string): string[] {
  return CITIES[city]?.boroughs.map((b) => b.name) ?? [];
}
