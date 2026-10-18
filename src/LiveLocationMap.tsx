import { useEffect } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

export interface TrackedLocation {
  latitude: number
  longitude: number
  timestamp: number
}

function FollowLocation({ location }: { location: TrackedLocation | undefined }) {
  const map = useMap();
  const latitude = location?.latitude;
  const longitude = location?.longitude;

  useEffect(() => {
    if (latitude !== undefined && longitude !== undefined) {
      map.flyTo([latitude, longitude], Math.max(map.getZoom(), 16), { duration: 0.7 });
    }
  }, [latitude, longitude, map]);

  return null;
}

export default function LiveLocationMap({
  locations,
  fallAlertActive,
}: {
  locations: TrackedLocation[]
  fallAlertActive: boolean
}) {
  const currentLocation = locations.at(-1);
  const path = locations.map(({ latitude, longitude }) => [latitude, longitude] as [number, number]);

  return (
    <MapContainer
      className="live-location-map"
      center={currentLocation ? [currentLocation.latitude, currentLocation.longitude] : [20, 0]}
      zoom={currentLocation ? 16 : 2}
      scrollWheelZoom
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FollowLocation location={currentLocation} />
      {path.length > 1 && <Polyline positions={path} pathOptions={{ color: fallAlertActive ? '#dc2626' : '#4f46e5', weight: 5 }} />}
      {path.length > 1 && (
        <CircleMarker
          center={path[0]}
          radius={6}
          pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#4f46e5', fillOpacity: 1 }}
        />
      )}
      {currentLocation && (
        <CircleMarker
          center={[currentLocation.latitude, currentLocation.longitude]}
          radius={9}
          pathOptions={{ color: '#ffffff', weight: 3, fillColor: fallAlertActive ? '#dc2626' : '#059669', fillOpacity: 1 }}
        />
      )}
    </MapContainer>
  );
}
