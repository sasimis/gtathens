"""Convert the local OSM extract (map.osm) into the game's map_data.json.

Output (public/map_data.json):
{
  "ref": {"lat": <ref_lat>, "lon": <ref_lon>},
  "buildings": [
    {
      "category": "commercial|residential|industrial|civic|mixed",
      "levels": 4,          # optional, from building:levels
      "height": 12.5,       # optional meters, from building:height / height
      "nodes": [{"lat": .., "lon": ..}, ...]
    }
  ],
  "roads": [{"type": "primary", "name": "Sideways", "nodes": [...]}],
  "grass": [{"nodes": [...]}, ...],
  "areas": [{"name": "Monastiraki", "nodes": [...]}, ...]
}

Buildings keep their OSM category so the game can spawn a matching Kenney
City Kit model (commercial / suburban / industrial).

`roads[].name` is the real OSM `name` tag (StreetHUD street chip + banner).
`areas` = named `place=*` features (neighbourhood polygon / city point) —
the HUD's label fallback when off a named road. The HUD must NEVER invent
road-class labels ("Service Rd", "Link", ...): user-facing labels are real
road names + area names only.
"""

import json
import re
import xml.etree.ElementTree as ET

# World origin of the scene (center of the OSM extract). Keep in sync with
# src/lib/geo.js — both files must use the same reference point.
REF_LAT = 37.975521
REF_LON = 23.733642

COMMERCIAL_VALUES = {
    'commercial', 'retail', 'office', 'supermarket', 'hotel', 'bank',
    'kiosk', 'government', 'public', 'civic', 'mall', 'commercial;residential',
}
RESIDENTIAL_VALUES = {
    'residential', 'apartments', 'house', 'detached', 'bungalow',
    'semidetached_house', 'terrace', 'dormitory', 'condominium',
}
INDUSTRIAL_VALUES = {
    'industrial', 'warehouse', 'factory', 'hangar', 'garage', 'garages',
    'shed', 'construction', 'service', 'guardhouse',
}
CIVIC_VALUES = {
    'church', 'cathedral', 'chapel', 'mosque', 'temple', 'synagogue',
    'school', 'university', 'college', 'kindergarten', 'hospital',
    'train_station', 'station', 'stadium', 'grandstand', 'museum', 'theatre',
}


def classify_building(value):
    """Map an OSM building=* value to one of the game's model categories."""
    if not value:
        return 'mixed'
    v = value.strip().lower()
    if v in COMMERCIAL_VALUES:
        return 'commercial'
    if v in RESIDENTIAL_VALUES:
        return 'residential'
    if v in INDUSTRIAL_VALUES:
        return 'industrial'
    if v in CIVIC_VALUES:
        return 'civic'
    # yes / generic -> decided at runtime from footprint size
    return 'mixed'


def parse_number(raw):
    """Extract the first number from strings like '12', '12 m' or '12;14'."""
    if raw is None:
        return None
    m = re.search(r'-?\d+(?:\.\d+)?', str(raw))
    return float(m.group()) if m else None


def clean_name(raw):
    """Whitespace-collapsed OSM street/area name, or None when absent."""
    if not raw:
        return None
    return ' '.join(str(raw).split()) or None


def parse_osm(file_path):
    tree = ET.parse(file_path)
    root = tree.getroot()

    # All map nodes keyed by id -> (lat, lon)
    nodes = {}
    for node in root.iter('node'):
        nodes[node.get('id')] = (float(node.get('lat')), float(node.get('lon')))

    buildings = []
    roads = []
    grass = []
    areas = []
    categories = {}

    for way in root.iter('way'):
        tags = {t.get('k'): t.get('v') for t in way.findall('tag')}
        coords = [nodes[nd.get('ref')] for nd in way.findall('nd')
                  if nd.get('ref') in nodes]
        if len(coords) < 2:
            continue

        if tags.get('building'):
            building = {
                'category': classify_building(tags.get('building')),
                'nodes': [{'lat': lat, 'lon': lon} for lat, lon in coords],
            }
            height = parse_number(tags.get('building:height') or tags.get('height'))
            levels = parse_number(tags.get('building:levels') or tags.get('levels'))
            if height and 2 <= height <= 400:
                building['height'] = height
            elif levels and 0.5 <= levels <= 120:
                building['levels'] = levels
            categories[building['category']] = categories.get(building['category'], 0) + 1
            buildings.append(building)
        elif tags.get('highway'):
            road = {
                'type': tags.get('highway'),
                'nodes': [{'lat': lat, 'lon': lon} for lat, lon in coords],
            }
            # Real OSM street name (name / name:en fallback). Drives the
            # street-change banner + chip (StreetHUD) and the minimap label.
            name = clean_name(tags.get('name') or tags.get('name:en'))
            if name:
                road['name'] = name
            roads.append(road)
        elif tags.get('landuse') == 'grass':
            grass.append({
                'nodes': [{'lat': lat, 'lon': lon} for lat, lon in coords],
            })
        elif tags.get('place'):
            # Named place (neighbourhood/suburb/city polygon) -> area-label
            # fallback for the HUD when off a named road.
            name = clean_name(tags.get('name') or tags.get('name:en'))
            if name:
                areas.append({
                    'name': name,
                    'nodes': [{'lat': lat, 'lon': lon} for lat, lon in coords],
                })

    # Named place POINTS (e.g. place=city markers) -> single-node areas.
    for node in root.iter('node'):
        tags = {t.get('k'): t.get('v') for t in node.findall('tag')}
        if not tags.get('place'):
            continue
        name = clean_name(tags.get('name') or tags.get('name:en'))
        ref = node.get('id')
        if name and ref in nodes:
            lat, lon = nodes[ref]
            areas.append({'name': name, 'nodes': [{'lat': lat, 'lon': lon}]})

    return buildings, roads, grass, areas, categories


def main():
    buildings, roads, grass, areas, categories = parse_osm('map.osm')
    data = {
        'ref': {'lat': REF_LAT, 'lon': REF_LON},
        'buildings': buildings,
        'roads': roads,
        'grass': grass,
        'areas': areas,
    }
    with open('public/map_data.json', 'w', encoding='utf-8') as f:
        json.dump(data, f, separators=(',', ':'))

    named = sum(1 for r in roads if r.get('name'))
    print(f"Found {len(buildings)} buildings, {len(roads)} roads "
          f"({named} named), {len(grass)} grass, {len(areas)} named areas.")
    print("Building categories:", json.dumps(categories, sort_keys=True))


if __name__ == '__main__':
    main()

