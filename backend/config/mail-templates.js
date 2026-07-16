const defaultUsageMailTemplates = {
  approvedSubject: "[申请已批准] {申请编号} {申请对象}",
  approvedBody: "{申请人}，你好：\n\n你的{申请类型}申请已批准。\n申请编号：{申请编号}\n申请对象：{申请对象}\n数量/金额：{数量金额}\n用途：{用途}\n审批意见：{审批意见}\n审批人：{审批人}\n审批时间：{审批时间}\n",
  rejectedSubject: "[申请未批准] {申请编号} {申请对象}",
  rejectedBody: "{申请人}，你好：\n\n你的{申请类型}申请未批准。\n申请编号：{申请编号}\n申请对象：{申请对象}\n数量/金额：{数量金额}\n用途：{用途}\n审批意见：{审批意见}\n审批人：{审批人}\n审批时间：{审批时间}\n"
};

const defaultApplicationMailTemplates = {
  acceptedSubject: "[加入申请已通过] {申请编号} {部门}",
  acceptedBody: "{申请人}，你好：\n\n你的加入申请已通过审核。\n申请编号：{申请编号}\n申请部门：{部门}\n审批意见：{审批意见}\n审批人：{审批人}\n审批时间：{审批时间}\n\n后续账号开通信息将另行发送。\n",
  rejectedSubject: "[加入申请未通过] {申请编号} {部门}",
  rejectedBody: "{申请人}，你好：\n\n你的加入申请本次未通过审核。\n申请编号：{申请编号}\n申请部门：{部门}\n审批意见：{审批意见}\n审批人：{审批人}\n审批时间：{审批时间}\n"
};

export { defaultUsageMailTemplates, defaultApplicationMailTemplates };
