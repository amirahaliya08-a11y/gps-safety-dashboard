export interface DeviceTelemetry {
  type: 'telemetry'
  timestamp?: string
  gps?: {
    latitude: number
    longitude: number
    fix?: boolean
  }
  accelerometer?: {
    x: number
    y: number
    z: number
  }
  gyroscope?: {
    x: number
    y: number
    z: number
  }
  batteryPercent?: number
  fallDetected?: boolean
  buzzerActive?: boolean
  gsm?: {
    registered: boolean
    signalPercent?: number
    network?: string
  }
  vibratorActive?: boolean
  ledsActive?: boolean
  electrodes?: {
    contactDetected: boolean
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readVector(
  value: unknown,
  fieldName: string,
): DeviceTelemetry['accelerometer'] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(`${fieldName} must be an object`)

  const { x, y, z } = value
  if (
    typeof x !== 'number' || !Number.isFinite(x) ||
    typeof y !== 'number' || !Number.isFinite(y) ||
    typeof z !== 'number' || !Number.isFinite(z)
  ) {
    throw new Error(`${fieldName} must contain finite x, y, and z numbers`)
  }

  return { x, y, z }
}

export function parseDeviceMessage(message: string): DeviceTelemetry {
  let value: unknown
  try {
    value = JSON.parse(message)
  } catch {
    throw new Error('Device sent invalid JSON')
  }

  if (!isRecord(value) || value.type !== 'telemetry') {
    throw new Error('Expected a telemetry message')
  }

  const telemetry: DeviceTelemetry = { type: 'telemetry' }

  if (value.timestamp !== undefined) {
    if (typeof value.timestamp !== 'string') throw new Error('timestamp must be a string')
    telemetry.timestamp = value.timestamp
  }

  if (value.gps !== undefined) {
    if (!isRecord(value.gps)) throw new Error('gps must be an object')
    const { latitude, longitude, fix } = value.gps
    if (
      typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    ) {
      throw new Error('gps must contain valid latitude and longitude coordinates')
    }
    if (fix !== undefined && typeof fix !== 'boolean') throw new Error('gps.fix must be a boolean')
    telemetry.gps = { latitude, longitude, ...(fix === undefined ? {} : { fix }) }
  }

  const accelerometer = readVector(value.accelerometer, 'accelerometer')
  if (accelerometer) telemetry.accelerometer = accelerometer

  const gyroscope = readVector(value.gyroscope, 'gyroscope')
  if (gyroscope) telemetry.gyroscope = gyroscope

  if (value.batteryPercent !== undefined) {
    if (
      typeof value.batteryPercent !== 'number' ||
      !Number.isFinite(value.batteryPercent) ||
      value.batteryPercent < 0 ||
      value.batteryPercent > 100
    ) {
      throw new Error('batteryPercent must be a number from 0 to 100')
    }
    telemetry.batteryPercent = value.batteryPercent
  }

  if (value.fallDetected !== undefined) {
    if (typeof value.fallDetected !== 'boolean') throw new Error('fallDetected must be a boolean')
    telemetry.fallDetected = value.fallDetected
  }

  if (value.buzzerActive !== undefined) {
    if (typeof value.buzzerActive !== 'boolean') throw new Error('buzzerActive must be a boolean')
    telemetry.buzzerActive = value.buzzerActive
  }

  if (value.gsm !== undefined) {
    if (!isRecord(value.gsm)) throw new Error('gsm must be an object')
    const { registered, signalPercent, network } = value.gsm
    if (typeof registered !== 'boolean') throw new Error('gsm.registered must be a boolean')
    if (
      signalPercent !== undefined &&
      (typeof signalPercent !== 'number' || !Number.isFinite(signalPercent) || signalPercent < 0 || signalPercent > 100)
    ) {
      throw new Error('gsm.signalPercent must be a number from 0 to 100')
    }
    if (network !== undefined && typeof network !== 'string') throw new Error('gsm.network must be a string')
    telemetry.gsm = {
      registered,
      ...(signalPercent === undefined ? {} : { signalPercent }),
      ...(network === undefined ? {} : { network }),
    }
  }

  if (value.vibratorActive !== undefined) {
    if (typeof value.vibratorActive !== 'boolean') throw new Error('vibratorActive must be a boolean')
    telemetry.vibratorActive = value.vibratorActive
  }

  if (value.ledsActive !== undefined) {
    if (typeof value.ledsActive !== 'boolean') throw new Error('ledsActive must be a boolean')
    telemetry.ledsActive = value.ledsActive
  }

  if (value.electrodes !== undefined) {
    if (!isRecord(value.electrodes)) throw new Error('electrodes must be an object')
    if (typeof value.electrodes.contactDetected !== 'boolean') {
      throw new Error('electrodes.contactDetected must be a boolean')
    }
    telemetry.electrodes = { contactDetected: value.electrodes.contactDetected }
  }

  return telemetry
}
