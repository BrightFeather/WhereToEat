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

const CITIES: Record<string, CityRegions> = {
  nyc: NYC,
};

export function getCityRegions(city: string): CityRegions | null {
  return CITIES[city] ?? null;
}

export function getBoroughNames(city: string): string[] {
  return CITIES[city]?.boroughs.map((b) => b.name) ?? [];
}
