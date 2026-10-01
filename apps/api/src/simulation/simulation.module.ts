import { SimulationPool } from "@circuitlab/runner";
import { Module } from "@nestjs/common";
import { CircuitsModule } from "../circuits/circuits.module";
import { AppConfig } from "../config/app-config";
import { SimulationPoolService, createSimulationPool } from "./simulation-pool.service";
import { SimulationController } from "./simulation.controller";
import { SimulationService } from "./simulation.service";

@Module({
  imports: [CircuitsModule],
  controllers: [SimulationController],
  // A factory provider: Nest calls createSimulationPool with the AppConfig, once, and injects the
  // pool wherever SimulationPool is asked for.
  providers: [{ provide: SimulationPool, useFactory: createSimulationPool, inject: [AppConfig] }, SimulationPoolService, SimulationService],
  exports: [SimulationPoolService],
})
export class SimulationModule {}
