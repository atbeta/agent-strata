mod model;
mod net;
mod output;
mod plan;
mod process;
mod runtime;
mod store;
mod supervisor;

#[cfg(test)]
mod test_support;

pub(crate) use model::{
    resolve_mode, Attention, OpencodeMode, OpencodePlan, OpencodeRuntime, OpencodeState,
};
pub(crate) use net::{health_ok, port_is_free};
pub(crate) use output::{classify, AUTH_PROMPT, AUTH_REFUSED};
pub(crate) use plan::{
    child_env, plan_with_port, previous_port, random_password, serve_args, service_env,
};
#[cfg(windows)]
pub(crate) use process::kill_tree;
pub(crate) use process::{
    cleanup_stale_opencode, cleanup_stale_service, command_for, reap_opencode_on_port, write_pid,
    write_pid_plain,
};
pub(crate) use runtime::{detect_runtime, resolve_bin, write_runtime};
pub(crate) use store::{read_mode, write_desktop_bin, write_status};
pub(crate) use supervisor::{supervise, Spawned};
