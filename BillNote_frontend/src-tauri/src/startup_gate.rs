//! Only serialize startup. The official single-instance plugin owns IPC and
//! lifetime exclusivity; this gate closes its mutex-to-IPC-window startup race.
use std::io;
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
};

pub struct StartupGate(HANDLE);

impl StartupGate {
    pub fn acquire(identifier: &str) -> io::Result<Self> {
        // Do not use the plugin's own "-sim" mutex. Preview identifiers naturally
        // produce a different gate, while all copies of the same app share one.
        let name: Vec<u16> = format!("{identifier}-bilinote-startup-gate")
            .encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let result = unsafe { WaitForSingleObject(handle, 30_000) };
        match result {
            // An abandoned mutex is acquired too; no backend has been started
            // by this process yet, so continuing initialization is safe.
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self(handle)),
            _ => {
                let error = if result == WAIT_TIMEOUT {
                    io::Error::new(io::ErrorKind::TimedOut, "另一个 BiliNote Studio 实例仍在初始化")
                } else {
                    io::Error::last_os_error()
                };
                unsafe { CloseHandle(handle); }
                Err(error)
            }
        }
    }
}

impl Drop for StartupGate {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}
