import { Client } from 'ssh2';

export interface SSHCredentials {
  host: string;
  username: string;
  password: string;
  port?: number;
}

export interface FirmwareInfo {
  current: string | null;
  available: string | null;
  updateAvailable: boolean;
}

export interface UpdateResult {
  success: boolean;
  firmwareBefore: string | null;
  firmwareAfter: string | null;
  error?: string;
}

const SSH_TIMEOUT = 30000; // 30 seconds
const COMMAND_TIMEOUT = 60000; // 60 seconds

export async function executeSSHCommand(
  credentials: SSHCredentials,
  command: string,
  timeout: number = COMMAND_TIMEOUT
): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let errorOutput = '';
    let commandTimeout: NodeJS.Timeout;

    conn.on('ready', () => {
      commandTimeout = setTimeout(() => {
        conn.end();
        reject(new Error('Command timeout'));
      }, timeout);

      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(commandTimeout);
          conn.end();
          reject(err);
          return;
        }

        stream.on('close', (code: number) => {
          clearTimeout(commandTimeout);
          conn.end();
          if (code === 0 || output) {
            resolve(output.trim());
          } else {
            reject(new Error(errorOutput || `Command exited with code ${code}`));
          }
        });

        stream.on('data', (data: Buffer) => {
          output += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          errorOutput += data.toString();
        });
      });
    });

    conn.on('error', (err) => {
      reject(err);
    });

    conn.connect({
      host: credentials.host,
      port: credentials.port || 22,
      username: credentials.username,
      password: credentials.password,
      readyTimeout: SSH_TIMEOUT,
      algorithms: {
        kex: [
          'ecdh-sha2-nistp256',
          'ecdh-sha2-nistp384',
          'ecdh-sha2-nistp521',
          'diffie-hellman-group-exchange-sha256',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1',
          'diffie-hellman-group-exchange-sha1',
          'diffie-hellman-group1-sha1'
        ],
        cipher: [
          'aes128-ctr',
          'aes192-ctr',
          'aes256-ctr',
          'aes128-gcm@openssh.com',
          'aes256-gcm@openssh.com',
          'aes128-cbc',
          'aes192-cbc',
          'aes256-cbc',
          '3des-cbc'
        ],
        serverHostKey: [
          'ssh-ed25519',
          'ecdsa-sha2-nistp256',
          'ecdsa-sha2-nistp384',
          'ecdsa-sha2-nistp521',
          'rsa-sha2-512',
          'rsa-sha2-256',
          'ssh-rsa'
        ],
        hmac: [
          'hmac-sha2-256',
          'hmac-sha2-512',
          'hmac-sha1'
        ]
      }
    });
  });
}

export async function checkRouterConnectivity(credentials: SSHCredentials): Promise<boolean> {
  try {
    await executeSSHCommand(credentials, 'echo "connected"', 10000);
    return true;
  } catch {
    return false;
  }
}

export async function getFirmwareVersion(credentials: SSHCredentials): Promise<string | null> {
  try {
    const version = await executeSSHCommand(credentials, 'cat /etc/version');
    return version || null;
  } catch {
    return null;
  }
}

export async function getFirmwareInfo(credentials: SSHCredentials): Promise<FirmwareInfo> {
  try {
    // Get current firmware
    const current = await getFirmwareVersion(credentials);

    // Get available firmware from FOTA service
    let available: string | null = null;
    try {
      const fotaInfo = await executeSSHCommand(credentials, 'ubus call rut_fota get_info');
      const parsed = JSON.parse(fotaInfo);
      if (parsed.fw && parsed.fw !== 'Fw_newest') {
        available = parsed.fw;
      }
    } catch {
      // FOTA info not available
    }

    return {
      current,
      available,
      updateAvailable: available !== null && available !== current
    };
  } catch (error) {
    throw new Error(`Failed to get firmware info: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function downloadFirmware(credentials: SSHCredentials): Promise<boolean> {
  try {
    // Start download
    await executeSSHCommand(credentials, 'rut_fota --download_fw', 300000); // 5 minutes timeout

    // Verify download
    const checkFile = await executeSSHCommand(credentials, 'ls -la /tmp/firmware.img 2>/dev/null || echo "NOT_FOUND"');
    return !checkFile.includes('NOT_FOUND');
  } catch (error) {
    console.error('Firmware download failed:', error);
    return false;
  }
}

export async function performUpdate(credentials: SSHCredentials): Promise<UpdateResult> {
  const result: UpdateResult = {
    success: false,
    firmwareBefore: null,
    firmwareAfter: null
  };

  try {
    // Get current firmware version
    result.firmwareBefore = await getFirmwareVersion(credentials);

    // Check if firmware file exists, if not download it
    const fileCheck = await executeSSHCommand(credentials, 'ls -la /tmp/firmware.img 2>/dev/null || echo "NOT_FOUND"');

    if (fileCheck.includes('NOT_FOUND')) {
      // Download firmware
      console.log('Downloading firmware...');
      const downloaded = await downloadFirmware(credentials);
      if (!downloaded) {
        result.error = 'Firmware download failed';
        return result;
      }
    }

    // Verify image
    try {
      await executeSSHCommand(credentials, 'sysupgrade -T /tmp/firmware.img');
    } catch {
      result.error = 'Firmware image verification failed';
      return result;
    }

    // Perform upgrade with config preservation
    // This will disconnect the SSH session
    try {
      await executeSSHCommand(credentials, 'sysupgrade -c /tmp/firmware.img', 120000);
    } catch (error) {
      // Expected - connection will be closed during reboot
      if (error instanceof Error && !error.message.includes('closed')) {
        result.error = `Upgrade command failed: ${error.message}`;
        return result;
      }
    }

    result.success = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Unknown error';
    return result;
  }
}

export async function verifyUpdateAfterReboot(
  credentials: SSHCredentials,
  expectedVersion: string | null,
  maxRetries: number = 20,
  retryInterval: number = 30000
): Promise<{ success: boolean; newVersion: string | null; error?: string }> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const newVersion = await getFirmwareVersion(credentials);
      if (newVersion) {
        const success = expectedVersion ? newVersion === expectedVersion : true;
        return { success, newVersion };
      }
    } catch {
      // Router not yet available, wait and retry
    }

    if (i < maxRetries - 1) {
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }
  }

  return { success: false, newVersion: null, error: 'Router did not come back online after update' };
}
