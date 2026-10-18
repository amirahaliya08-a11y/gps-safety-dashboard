import { useState, useEffect } from 'react';

export default function GpsTracker() {
  const [location, setLocation] = useState({ lat: null, lng: null });
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!navigator.geolocation) {
      setError('Geolocation tidak disokong oleh browser anda.');
      return;
    }

    const handleSuccess = (position) => {
      setLocation({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      });
      setError(null);
    };

    const handleError = (err) => {
      console.error(err);
      switch(err.code) {
        case err.PERMISSION_DENIED:
          setError("User denied the request for Geolocation. Sila benarkan akses lokasi pada browser.");
          break;
        case err.POSITION_UNAVAILABLE:
          setError("Location information is unavailable.");
          break;
        case err.TIMEOUT:
          setError("The request to get user location timed out.");
          break;
        default:
          setError("An unknown error occurred.");
          break;
      }
    };

    // Guna watchPosition supaya dia sentiasa track pergerakan GPS
    const watcher = navigator.geolocation.watchPosition(handleSuccess, handleError, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    });

    return () => navigator.geolocation.clearWatch(watcher);
  }, []);

  return (
    <div className="p-4 bg-white rounded-lg shadow-md">
      <h2 className="text-lg font-bold mb-2">GPS Status</h2>
      {error ? (
        <p className="text-red-500 text-sm">Error: {error}</p>
      ) : (
        <p className="text-green-600 text-sm">
          Lat: {location.lat ?? 'Memuatkan...'}, Lng: {location.lng ?? 'Memuatkan...'}
        </p>
      )}
    </div>
  );
}