//! Windows-specific process management: Job Objects and process tree termination.
//!
//! Provides a kernel-level guarantee that `server.exe` (and any child processes
//! it spawns) will be terminated whenever CourseDeck exits or is killed.

#![cfg(target_os = "windows")]

use std::os::windows::io::AsRawHandle;
use std::ptr;

type HANDLE = *mut std::ffi::c_void;
type BOOL = i32;
type DWORD = u32;

const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: DWORD = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;

#[repr(C)]
struct IO_COUNTERS {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: DWORD,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: DWORD,
    affinity: usize,
    priority_class: DWORD,
    scheduling_class: DWORD,
}

#[repr(C)]
struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    basic_limit_information: JOBOBJECT_BASIC_LIMIT_INFORMATION,
    io_info: IO_COUNTERS,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(job_attributes: *mut std::ffi::c_void, name: *const u16) -> HANDLE;
    fn SetInformationJobObject(
        job: HANDLE,
        info_class: u32,
        info: *const std::ffi::c_void,
        info_length: u32,
    ) -> BOOL;
    fn AssignProcessToJobObject(job: HANDLE, process: HANDLE) -> BOOL;
    fn CloseHandle(object: HANDLE) -> BOOL;
}

pub struct JobObjectHandle(HANDLE);

unsafe impl Send for JobObjectHandle {}
unsafe impl Sync for JobObjectHandle {}

impl Drop for JobObjectHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Creates a Windows Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
/// and assigns the child process to it.
///
/// When the returned `JobObjectHandle` is dropped, or when CourseDeck exits
/// (even abruptly via crash or Task Manager kill), the Windows OS kernel
/// automatically terminates the child process and any descendants.
pub fn assign_to_job_object(child: &std::process::Child) -> Option<JobObjectHandle> {
    unsafe {
        let job = CreateJobObjectW(ptr::null_mut(), ptr::null());
        if job.is_null() || job == INVALID_HANDLE_VALUE {
            eprintln!("[Tauri] Failed to create Windows Job Object");
            return None;
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let ok = SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            eprintln!("[Tauri] Failed to set Job Object extended limit info");
            CloseHandle(job);
            return None;
        }

        let proc_handle = child.as_raw_handle() as HANDLE;
        let ok = AssignProcessToJobObject(job, proc_handle);
        if ok == 0 {
            eprintln!("[Tauri] Failed to assign backend child process to Job Object");
            CloseHandle(job);
            return None;
        }

        println!(
            "[Tauri] Assigned backend server (pid {}) to kill-on-close Job Object",
            child.id()
        );
        Some(JobObjectHandle(job))
    }
}
