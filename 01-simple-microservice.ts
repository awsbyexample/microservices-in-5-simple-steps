// Pulumi has two different AWS provider which we'll use in this code sample:
// 1. Native AWS provider: This provider is built on top of AWS's Cloud Control API and provides a more
// 2. Classic AWS provider: This provider is built on top of AWS's SDK and provides a more comprehensive set of resources and properties.
// 
// → Some resources are not yet available in the Native AWS provider, so we are using both providers in this example.

import * as awsClassic from "@pulumi/aws";
import * as awsnative from "@pulumi/aws-native";

/**
 * Classic AWS provider stuff
 */

// VPC = Virtual Private Cloud
// Subnet = A range of IP addresses in your VPC
const defaultVpc = awsClassic.ec2.getVpcOutput({ default: true });
const defaultVpcSubnets = awsClassic.ec2.getSubnetsOutput({
  filters: [
    { name: "vpc-id", values: [defaultVpc.id] },
  ],
});

// Security Group = A virtual firewall that controls inbound and outbound traffic to your instances
const group = new awsClassic.ec2.SecurityGroup("web-secgrp", {
  vpcId: defaultVpc.id,
  description: "Enable HTTP access",
  ingress: [{
    protocol: "tcp",
    fromPort: 80,
    toPort: 80,
    cidrBlocks: ["0.0.0.0/0"],
  }],
  egress: [{
    protocol: "-1",
    fromPort: 0,
    toPort: 0,
    cidrBlocks: ["0.0.0.0/0"],
  }],
});

// ALB = Application Load Balancer (can route based on path (e.g. /api, /billing etc.))
const alb = new awsClassic.lb.LoadBalancer("app-lb", {
  securityGroups: [group.id],
  subnets: defaultVpcSubnets.ids,
});

// Target Group = For a VM (=EC2 instance) on AWS, to be reachable by a load balancer, it must be registered with a target group
const todoAppTg = new awsClassic.lb.TargetGroup("todo-app-tg", {
  port: 80,
  protocol: "HTTP",
  targetType: "ip",
  vpcId: defaultVpc.id,
});

// The role that the ECS tasks will receive once it's running
const ecsTaskInitializationRole = new awsClassic.iam.Role("task-init-role", {
  assumeRolePolicy: {
    Version: "2008-10-17",
    Statement: [{
      Sid: "",
      Effect: "Allow",
      Principal: {
        Service: "ecs-tasks.amazonaws.com",
      },
      Action: "sts:AssumeRole",
    }],
  },
});

// Here we simply attach the AmazonECSTaskExecutionRolePolicy policy to the role (= a predefined set of permissions)
// See details here: https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonECSTaskExecutionRolePolicy.html
const rpa = new awsClassic.iam.RolePolicyAttachment("task-exec-policy", {
  role: ecsTaskInitializationRole.name,
  policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
});

/**
 * Native AWS provider stuff
 */
// Cluster -[has multiple]→ Services -[has multiple]→ Tasks -[has 1-x]→ Containers
const cluster = new awsnative.ecs.Cluster("aws-by-example");

const wl = new awsnative.elasticloadbalancingv2.Listener("web", {
  loadBalancerArn: alb.arn,
  port: 80,
  protocol: "HTTP",
  defaultActions: [{
    type: "forward",
    targetGroupArn: todoAppTg.arn,
  }],
});

const taskDefinition = new awsnative.ecs.TaskDefinition("app-task", {
  // Name of the family of tasks this belongs to - this is used to group tasks together (for versioning)
  family: "abe-app-task",
  // vCPUs for your task - they use a weird unit here:
  // 256 = 0.25 vCPU
  // 512 = 0.5 vCPU
  // 1024 = 1 vCPU
  // 2048 = 2 vCPU
  // 4096 = 4 vCPU
  // See available CPU sized here: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html#task_size
  cpu: "256",
  // Memory in MB - depending on the vCPU setting, there's different RAM settings which you can use
  // → See available combos here: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html#task_size
  memory: "512",
  // Needs to be "awsvpc" since we're using Fargate
  networkMode: "awsvpc",
  requiresCompatibilities: ["FARGATE"],
  executionRoleArn: ecsTaskInitializationRole.arn,
  containerDefinitions: [{
    name: "example-webserver",
    image: "nginx",
    portMappings: [{
      containerPort: 80,
      hostPort: 80,
      protocol: "tcp",
    }],
  }],
});

const service = new awsnative.ecs.Service("app-svc", {
  cluster: cluster.arn,
  desiredCount: 1,
  launchType: "FARGATE",
  taskDefinition: taskDefinition.taskDefinitionArn,
  networkConfiguration: {
    awsvpcConfiguration: {
      assignPublicIp: "ENABLED",
      subnets: defaultVpcSubnets.ids,
      securityGroups: [group.id],
    },
  },
  loadBalancers: [{
    targetGroupArn: todoAppTg.arn,
    containerName: "example-webserver",
    containerPort: 80,
  }],
}, { dependsOn: [wl] });

export const publicUrl = alb.dnsName;