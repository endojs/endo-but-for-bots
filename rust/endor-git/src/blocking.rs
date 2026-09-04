//! Bounded synchronous-to-asynchronous execution.

use std::future::Future;
use std::sync::Arc;

use tokio::sync::Semaphore;

use crate::GitError;

/// A reusable bound around libgit2 work submitted to Tokio's blocking pool.
#[derive(Clone)]
pub struct BoundedGitExecutor {
    permits: Arc<Semaphore>,
}

impl BoundedGitExecutor {
    /// Creates an executor that admits at most `maximum_concurrency` calls.
    pub fn new(maximum_concurrency: usize) -> Result<Self, GitError> {
        if maximum_concurrency == 0 {
            return Err(GitError::BlockingTask(
                "maximum concurrency must be greater than zero".to_owned(),
            ));
        }
        Ok(Self {
            permits: Arc::new(Semaphore::new(maximum_concurrency)),
        })
    }

    /// Runs one synchronous Git operation after acquiring a bounded permit.
    pub fn run<F, T>(&self, operation: F) -> impl Future<Output = Result<T, GitError>>
    where
        F: FnOnce() -> Result<T, GitError> + Send + 'static,
        T: Send + 'static,
    {
        let permits = Arc::clone(&self.permits);
        async move {
            let permit = permits
                .acquire_owned()
                .await
                .map_err(|error| GitError::BlockingTask(error.to_string()))?;
            let result = tokio::task::spawn_blocking(operation)
                .await
                .map_err(|error| GitError::BlockingTask(error.to_string()))?;
            drop(permit);
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use super::BoundedGitExecutor;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn bounds_blocking_concurrency() {
        let executor = BoundedGitExecutor::new(2).unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();

        for _ in 0..8 {
            let executor = executor.clone();
            let active = Arc::clone(&active);
            let maximum = Arc::clone(&maximum);
            tasks.push(tokio::spawn(async move {
                executor
                    .run(move || {
                        let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(now, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(10));
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .await
            }));
        }

        for task in tasks {
            task.await.unwrap().unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 2);
    }
}
