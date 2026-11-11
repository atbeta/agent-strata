use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::model::{Attention, AttentionKind, OpencodePlan, OpencodeState};
use super::plan::backoff;
#[cfg(test)]
use super::store::read_status;
use super::store::{write_status, write_status_asking};

pub struct Spawned {
    pub exited: Arc<AtomicBool>,
    pub kill: Box<dyn Fn() + Send>,
    /// 0 while serving, 1 parked at a login prompt, 2 after refused credentials.
    pub auth_stage: Option<Arc<std::sync::atomic::AtomicU8>>,
    /// The question recognised by this child's output scanner, if it is scanned.
    pub attention: Option<Arc<Mutex<Option<Attention>>>>,
}

pub fn supervise<S, H, W>(
    plan: OpencodePlan,
    status_path: &Path,
    spawn: S,
    healthy: H,
    wait: W,
    shutdown: Arc<AtomicBool>,
    restart: Arc<AtomicBool>,
) where
    S: Fn(&OpencodePlan) -> std::io::Result<Spawned>,
    H: Fn(&OpencodePlan) -> bool,
    W: Fn(Duration),
{
    let mut attempt: u32 = 0;
    let mut unsuccessful: u32 = 0;

    loop {
        if shutdown.load(Ordering::SeqCst) {
            let _ = write_status(
                status_path,
                plan.mode,
                OpencodeState::Stopped,
                Some(&plan.url),
                None,
            );
            return;
        }
        restart.store(false, Ordering::SeqCst);
        let _ = write_status(
            status_path,
            plan.mode,
            OpencodeState::Starting,
            Some(&plan.url),
            Some((plan.username.as_str(), plan.password.as_str())),
        );
        let spawned = match spawn(&plan) {
            Ok(child) => child,
            Err(_) => {
                let _ = write_status(
                    status_path,
                    plan.mode,
                    OpencodeState::Stopped,
                    Some(&plan.url),
                    None,
                );
                return;
            }
        };
        let mut reached_running = false;

        if !spawned.exited.load(Ordering::SeqCst) {
            let mut polls = 0u32;
            let mut auth_written: i8 = -1;
            let mut asking: Option<String> = None;
            while polls < 40 && !spawned.exited.load(Ordering::SeqCst) {
                // A successful login can leave the stage marker stale, so health wins.
                if healthy(&plan) {
                    let _ = write_status(
                        status_path,
                        plan.mode,
                        OpencodeState::Running,
                        Some(&plan.url),
                        Some((plan.username.as_str(), plan.password.as_str())),
                    );
                    attempt = 0;
                    unsuccessful = 0;
                    reached_running = true;
                    break;
                }
                let attention = spawned
                    .attention
                    .as_ref()
                    .and_then(|slot| slot.lock().ok().and_then(|found| found.clone()));
                if let Some(attention) = attention {
                    if attention.kind != AttentionKind::Login {
                        let key = format!("{}:{}", attention.kind.as_str(), attention.message);
                        if asking.as_deref() != Some(key.as_str()) {
                            let _ = write_status_asking(
                                status_path,
                                plan.mode,
                                OpencodeState::NeedsInput,
                                Some(&plan.url),
                                Some((plan.username.as_str(), plan.password.as_str())),
                                Some(attention),
                            );
                            asking = Some(key);
                        }
                        wait(Duration::from_millis(400));
                        if shutdown.load(Ordering::SeqCst) {
                            (spawned.kill)();
                            let _ = write_status(
                                status_path,
                                plan.mode,
                                OpencodeState::Stopped,
                                Some(&plan.url),
                                None,
                            );
                            return;
                        }
                        if restart.swap(false, Ordering::SeqCst) {
                            (spawned.kill)();
                            break;
                        }
                        continue;
                    }
                }
                let stage = spawned
                    .auth_stage
                    .as_ref()
                    .map(|s| s.load(Ordering::SeqCst))
                    .unwrap_or(0);
                if stage > 0 {
                    if auth_written != stage as i8 {
                        let _ = write_status(
                            status_path,
                            plan.mode,
                            if stage == 2 {
                                OpencodeState::AuthFailed
                            } else {
                                OpencodeState::AuthRequired
                            },
                            Some(&plan.url),
                            Some((plan.username.as_str(), plan.password.as_str())),
                        );
                        auth_written = stage as i8;
                    }
                    wait(Duration::from_millis(400));
                    if shutdown.load(Ordering::SeqCst) {
                        (spawned.kill)();
                        let _ = write_status(
                            status_path,
                            plan.mode,
                            OpencodeState::Stopped,
                            Some(&plan.url),
                            None,
                        );
                        return;
                    }
                    if restart.swap(false, Ordering::SeqCst) {
                        (spawned.kill)();
                        break;
                    }
                    continue;
                }
                wait(Duration::from_millis(200));
                polls += 1;
                if shutdown.load(Ordering::SeqCst) {
                    (spawned.kill)();
                    let _ = write_status(
                        status_path,
                        plan.mode,
                        OpencodeState::Stopped,
                        Some(&plan.url),
                        None,
                    );
                    return;
                }
                if restart.swap(false, Ordering::SeqCst) {
                    (spawned.kill)();
                    break;
                }
            }

            if reached_running {
                let mut unhealthy_streak = 0u32;
                loop {
                    wait(Duration::from_secs(5));
                    if shutdown.load(Ordering::SeqCst) {
                        (spawned.kill)();
                        let _ = write_status(
                            status_path,
                            plan.mode,
                            OpencodeState::Stopped,
                            Some(&plan.url),
                            None,
                        );
                        return;
                    }
                    if restart.swap(false, Ordering::SeqCst) {
                        (spawned.kill)();
                        break;
                    }
                    if spawned.exited.load(Ordering::SeqCst) {
                        break;
                    }
                    if healthy(&plan) {
                        unhealthy_streak = 0;
                    } else {
                        unhealthy_streak += 1;
                        if unhealthy_streak >= 3 {
                            (spawned.kill)();
                            break;
                        }
                    }
                }
            } else {
                (spawned.kill)();
            }
        }

        if !reached_running {
            unsuccessful += 1;
            if unsuccessful > 8 {
                let _ = write_status(
                    status_path,
                    plan.mode,
                    OpencodeState::Stopped,
                    Some(&plan.url),
                    None,
                );
                return;
            }
        }
        let _ = write_status(
            status_path,
            plan.mode,
            OpencodeState::Restarting,
            Some(&plan.url),
            Some((plan.username.as_str(), plan.password.as_str())),
        );
        attempt += 1;
        wait(backoff(attempt));
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{sample_plan, temp_path};
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn supervise_holds_a_parked_child(stage: u8, want: OpencodeState) {
        let plan = sample_plan();
        let status_path = temp_path("status.json");
        let shutdown = Arc::new(AtomicBool::new(false));
        let spawns = Arc::new(AtomicUsize::new(0));
        let kills = Arc::new(AtomicUsize::new(0));
        let states = Arc::new(Mutex::new(Vec::new()));
        supervise(
            plan,
            &status_path,
            {
                let spawns = spawns.clone();
                let kills = kills.clone();
                move |_| {
                    spawns.fetch_add(1, Ordering::SeqCst);
                    Ok(Spawned {
                        exited: Arc::new(AtomicBool::new(false)),
                        kill: Box::new({
                            let kills = kills.clone();
                            move || {
                                kills.fetch_add(1, Ordering::SeqCst);
                            }
                        }),
                        auth_stage: Some(Arc::new(std::sync::atomic::AtomicU8::new(stage))),
                        attention: None,
                    })
                }
            },
            |_| false,
            {
                let shutdown = shutdown.clone();
                let states = states.clone();
                let status_path = status_path.clone();
                let waits = AtomicUsize::new(0);
                move |_| {
                    if waits.fetch_add(1, Ordering::SeqCst) >= 2 {
                        shutdown.store(true, Ordering::SeqCst);
                    }
                    if let Some(status) = read_status(&status_path) {
                        let mut states = states.lock().unwrap();
                        if states.last() != Some(&status.state) {
                            states.push(status.state);
                        }
                    }
                }
            },
            shutdown,
            Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            spawns.load(Ordering::SeqCst),
            1,
            "a parked child was retried"
        );
        assert_eq!(kills.load(Ordering::SeqCst), 1);
        let seen = states.lock().unwrap().clone();
        assert!(seen.contains(&want), "expected {want:?} in {seen:?}");
        assert_eq!(
            read_status(&status_path).expect("status").state,
            OpencodeState::Stopped
        );
    }

    #[test]
    fn a_child_parked_at_the_login_prompt_holds_instead_of_failing() {
        supervise_holds_a_parked_child(1, OpencodeState::AuthRequired);
    }

    #[test]
    fn a_refused_login_parks_again_as_authfailed() {
        supervise_holds_a_parked_child(2, OpencodeState::AuthFailed);
    }

    #[test]
    fn supervise_healthy_first_poll_writes_running_and_respawns_same_plan() {
        let plan = sample_plan();
        let status_path = temp_path("status.json");
        let shutdown = Arc::new(AtomicBool::new(false));
        let spawn_plans = Arc::new(Mutex::new(Vec::new()));
        let saw_running = Arc::new(AtomicBool::new(false));
        let first_exited = Arc::new(AtomicBool::new(false));
        let running_waits = Arc::new(AtomicUsize::new(0));
        supervise(
            plan.clone(),
            &status_path,
            {
                let spawn_plans = spawn_plans.clone();
                let first_exited = first_exited.clone();
                move |p| {
                    spawn_plans.lock().unwrap().push(p.clone());
                    let is_first = spawn_plans.lock().unwrap().len() == 1;
                    Ok(Spawned {
                        exited: if is_first {
                            first_exited.clone()
                        } else {
                            Arc::new(AtomicBool::new(false))
                        },
                        kill: Box::new(|| {}),
                        auth_stage: None,
                        attention: None,
                    })
                }
            },
            |_| true,
            {
                let shutdown = shutdown.clone();
                let first_exited = first_exited.clone();
                let saw_running = saw_running.clone();
                let running_waits = running_waits.clone();
                let status_path = status_path.clone();
                move |d| {
                    if let Some(status) = read_status(&status_path) {
                        if status.state == OpencodeState::Running {
                            saw_running.store(true, Ordering::SeqCst);
                        }
                    }
                    if d == Duration::from_secs(5) {
                        let n = running_waits.fetch_add(1, Ordering::SeqCst);
                        if n == 0 {
                            first_exited.store(true, Ordering::SeqCst);
                        } else {
                            shutdown.store(true, Ordering::SeqCst);
                        }
                    }
                }
            },
            shutdown.clone(),
            Arc::new(AtomicBool::new(false)),
        );
        assert!(
            saw_running.load(Ordering::SeqCst),
            "first healthy poll should write running"
        );
        let spawned = spawn_plans.lock().unwrap();
        assert!(
            spawned.len() >= 2,
            "expected a second spawn after the first child exited, got {}",
            spawned.len()
        );
        assert_eq!(spawned[1].port, plan.port);
        assert_eq!(spawned[1].password, plan.password);
        assert_eq!(spawned[0].port, plan.port);
        assert_eq!(spawned[0].password, plan.password);
    }

    #[test]
    fn supervise_restart_replaces_a_healthy_child_without_waiting_for_exit() {
        let plan = sample_plan();
        let status_path = temp_path("status.json");
        let shutdown = Arc::new(AtomicBool::new(false));
        let restart = Arc::new(AtomicBool::new(false));
        let spawns = Arc::new(AtomicUsize::new(0));
        let kills = Arc::new(AtomicUsize::new(0));
        let waits = Arc::new(AtomicUsize::new(0));
        supervise(
            plan,
            &status_path,
            {
                let spawns = spawns.clone();
                let kills = kills.clone();
                move |_| {
                    spawns.fetch_add(1, Ordering::SeqCst);
                    Ok(Spawned {
                        exited: Arc::new(AtomicBool::new(false)),
                        kill: Box::new({
                            let kills = kills.clone();
                            move || {
                                kills.fetch_add(1, Ordering::SeqCst);
                            }
                        }),
                        auth_stage: None,
                        attention: None,
                    })
                }
            },
            |_| true,
            {
                let spawns = spawns.clone();
                let restart = restart.clone();
                let shutdown = shutdown.clone();
                let waits = waits.clone();
                move |_| {
                    if waits.fetch_add(1, Ordering::SeqCst) == 0 {
                        restart.store(true, Ordering::SeqCst);
                    } else if spawns.load(Ordering::SeqCst) >= 2 {
                        shutdown.store(true, Ordering::SeqCst);
                    }
                }
            },
            shutdown,
            restart,
        );
        assert!(spawns.load(Ordering::SeqCst) >= 2);
        assert!(kills.load(Ordering::SeqCst) >= 1);
    }

    #[test]
    fn supervise_shutdown_during_first_health_wait_stops_without_respawn() {
        let plan = sample_plan();
        let status_path = temp_path("status.json");
        let shutdown = Arc::new(AtomicBool::new(false));
        let kills = Arc::new(AtomicUsize::new(0));
        let spawns = Arc::new(AtomicUsize::new(0));
        supervise(
            plan,
            &status_path,
            {
                let spawns = spawns.clone();
                let kills = kills.clone();
                move |_| {
                    spawns.fetch_add(1, Ordering::SeqCst);
                    let kills = kills.clone();
                    Ok(Spawned {
                        exited: Arc::new(AtomicBool::new(false)),
                        kill: Box::new(move || {
                            kills.fetch_add(1, Ordering::SeqCst);
                        }),
                        auth_stage: None,
                        attention: None,
                    })
                }
            },
            |_| false,
            {
                let shutdown = shutdown.clone();
                move |_| {
                    shutdown.store(true, Ordering::SeqCst);
                }
            },
            shutdown.clone(),
            Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        assert_eq!(kills.load(Ordering::SeqCst), 1);
        assert_eq!(
            read_status(&status_path).expect("status").state,
            OpencodeState::Stopped
        );
    }

    #[test]
    fn supervise_unhealthy_streak_kills_before_restart() {
        let plan = sample_plan();
        let status_path = temp_path("status.json");
        let shutdown = Arc::new(AtomicBool::new(false));
        let spawns = Arc::new(AtomicUsize::new(0));
        let first_kills = Arc::new(AtomicUsize::new(0));
        let health_calls = Arc::new(AtomicUsize::new(0));
        supervise(
            plan,
            &status_path,
            {
                let spawns = spawns.clone();
                let first_kills = first_kills.clone();
                move |_| {
                    let n = spawns.fetch_add(1, Ordering::SeqCst);
                    let first_kills = first_kills.clone();
                    Ok(Spawned {
                        exited: Arc::new(AtomicBool::new(false)),
                        kill: Box::new(move || {
                            if n == 0 {
                                first_kills.fetch_add(1, Ordering::SeqCst);
                            }
                        }),
                        auth_stage: None,
                        attention: None,
                    })
                }
            },
            {
                let health_calls = health_calls.clone();
                move |_| health_calls.fetch_add(1, Ordering::SeqCst) == 0
            },
            {
                let shutdown = shutdown.clone();
                let spawns = spawns.clone();
                move |_| {
                    if spawns.load(Ordering::SeqCst) >= 2 {
                        shutdown.store(true, Ordering::SeqCst);
                    }
                }
            },
            shutdown,
            Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(first_kills.load(Ordering::SeqCst), 1);
        assert!(spawns.load(Ordering::SeqCst) >= 2);
    }

    #[test]
    fn supervise_eight_immediate_exits_stop_with_backoff_schedule() {
        let plan = sample_plan();
        let status_path = temp_path("status.json");
        let shutdown = Arc::new(AtomicBool::new(false));
        let spawns = Arc::new(AtomicUsize::new(0));
        let waits = Arc::new(Mutex::new(Vec::new()));
        supervise(
            plan,
            &status_path,
            {
                let spawns = spawns.clone();
                move |_| {
                    spawns.fetch_add(1, Ordering::SeqCst);
                    Ok(Spawned {
                        exited: Arc::new(AtomicBool::new(true)),
                        kill: Box::new(|| {}),
                        auth_stage: None,
                        attention: None,
                    })
                }
            },
            |_| panic!("health should not be polled for an already-exited child"),
            {
                let waits = waits.clone();
                move |d| {
                    waits.lock().unwrap().push(d);
                }
            },
            shutdown,
            Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(spawns.load(Ordering::SeqCst), 9);
        assert_eq!(
            *waits.lock().unwrap(),
            vec![
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4),
                Duration::from_secs(8),
                Duration::from_secs(30),
                Duration::from_secs(30),
                Duration::from_secs(30),
                Duration::from_secs(30),
            ]
        );
        assert_eq!(
            read_status(&status_path).expect("status").state,
            OpencodeState::Stopped
        );
    }
}
