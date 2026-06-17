const axios = require('axios');

// Coordenadas de Huechuraba, Santiago
const LAT = -33.3742;
const LON = -70.6725;

const WMO_CODES = {
  0: '☀️',
  1: '🌤️',
  2: '⛅',
  3: '☁️',
  45: '🌫️', 48: '🌫️',
  51: 'DRIZZLE', 53: 'DRIZZLE', 55: 'DRIZZLE',
  61: '🌧️', 63: '🌧️', 65: '🌧️',
  80: '🌦️', 81: '🌦️', 82: '🌦️',
  95: '⛈️', 96: '⛈️', 99: '⛈️',
};

const WMO_DESC = {
  0: 'Despejado',
  1: 'Mayormente despejado',
  2: 'Parcialmente nublado',
  3: 'Nublado',
  45: 'Neblina',
  48: 'Neblina',
  51: 'Llovizna ligera',
  53: 'Llovizna',
  55: 'Llovizna intensa',
  61: 'Lluvia ligera',
  63: 'Lluvia',
  65: 'Lluvia fuerte',
  80: 'Chubascos',
  81: 'Chubascos',
  82: 'Chubascos fuertes',
  95: 'Tormenta',
  96: 'Tormenta con granizo',
  99: 'Tormenta con granizo',
};

function getWeatherIcon(code) {
  if (WMO_CODES[code] === 'DRIZZLE') return '🌧️';
  return WMO_CODES[code] || '⛅';
}

function getWeatherDesc(code) {
  return WMO_DESC[code] || 'Variable';
}

function formatHour(isoString) {
  if (!isoString) return null;
  const date = new Date(isoString);
  return date.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDayShort(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString + 'T12:00:00');
  return date.toLocaleDateString('es-CL', { weekday: 'short' }).replace('.', '');
}

async function getWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunset,sunrise,precipitation_probability_max` +
      `&timezone=auto&forecast_days=7`;
    const response = await axios.get(url);

    const current = response.data.current;
    const daily = response.data.daily;
    const hoyIdx = 0;
    const mananaIdx = 1;

    const semana = daily.time.map((fecha, i) => ({
      fecha,
      dia: formatDayShort(fecha),
      icon: getWeatherIcon(daily.weather_code[i]),
      desc: getWeatherDesc(daily.weather_code[i]),
      tempMin: Math.round(daily.temperature_2m_min[i]),
      tempMax: Math.round(daily.temperature_2m_max[i]),
      lluvia: daily.precipitation_probability_max[i] ?? null,
    }));

    return {
      temp: Math.round(current.temperature_2m),
      feelsLike: Math.round(current.apparent_temperature),
      icon: getWeatherIcon(current.weather_code),
      desc: getWeatherDesc(current.weather_code),
      ubicacion: 'Huechuraba',
      humidity: current.relative_humidity_2m,
      wind: Math.round(current.wind_speed_10m),
      tempMin: Math.round(daily.temperature_2m_min[hoyIdx]),
      tempMax: Math.round(daily.temperature_2m_max[hoyIdx]),
      lluvia: daily.precipitation_probability_max[hoyIdx] ?? null,
      sunset: formatHour(daily.sunset[hoyIdx]),
      sunrise: formatHour(daily.sunrise[hoyIdx]),
      manana: daily.weather_code[mananaIdx] != null ? {
        icon: getWeatherIcon(daily.weather_code[mananaIdx]),
        desc: getWeatherDesc(daily.weather_code[mananaIdx]),
        tempMin: Math.round(daily.temperature_2m_min[mananaIdx]),
        tempMax: Math.round(daily.temperature_2m_max[mananaIdx]),
        lluvia: daily.precipitation_probability_max[mananaIdx] ?? null,
      } : null,
      semana,
    };
  } catch (error) {
    console.error('[CLIMA] Error obteniendo datos:', error.message);
    return null;
  }
}

module.exports = { getWeather };
