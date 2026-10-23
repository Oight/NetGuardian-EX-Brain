# 本地任务登记

当前使用本目录内的具体任务文件作为唯一任务状态来源，适用于三个账号的小组。GitHub Issue/PR 尚未启用，也不是本地开发门槛。

目前完成的是仓库初始化，记录见[初始化说明](../repository-setup.md)。尚无已领取的产品实现任务；建议下一项建立产品基座任务，再准备宿主 M0 离线验证计划。真实宿主、模型和平台操作仍需当次授权。

当前仓库维护任务：[T000 首次 GitHub 同步准备](T000-github-bootstrap.md)。实时状态仅维护在该任务文件中。

建立任务时复制[任务模板](../task-template.md)，填写真实 base commit、完成者、路径和验收。状态使用 planned、ready、in_progress、checking、done、blocked、cancelled；done 要求结果已合并到 main 且检查记录完整。

采用任务 ID 命名，例如 T001-foundation.md。共享文件先明确当次唯一写任务；不设专职审查者。以后若迁往 Issue，在原任务文件注明唯一新位置，停止双份状态维护。
