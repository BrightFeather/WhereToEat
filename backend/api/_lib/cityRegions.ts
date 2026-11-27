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

const CITIES: Record<string, CityRegions> = {
  nyc: NYC,
  bay: BAY,
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
};

export function getCityMeta(city: string): CityMeta {
  const meta = CITY_META[city];
  if (!meta) throw new Error(`Unknown city key: ${city}`);
  return meta;
}

/** Bay Area: map a Places `locality` (city name) to its region. */
export function regionForLocality(city: string, locality: string | null | undefined): string | null {
  if (!locality) return null;
  const regions = CITIES[city]?.boroughs ?? [];
  if (city === 'bay' && locality === 'San Francisco') return 'San Francisco';
  return regions.find((r) => r.neighborhoods.includes(locality))?.name ?? null;
}

export function getCityRegions(city: string): CityRegions | null {
  return CITIES[city] ?? null;
}

export function getBoroughNames(city: string): string[] {
  return CITIES[city]?.boroughs.map((b) => b.name) ?? [];
}
